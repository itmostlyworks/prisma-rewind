export interface TransactionClient<TTransaction = unknown> {
  transaction<TResult>(
    callback: (transaction: TTransaction) => PromiseLike<TResult>,
  ): Promise<TResult>;
}

export type TransactionalTestErrorCode =
  | 'NO_ACTIVE_TRANSACTION'
  | 'TRANSACTION_ALREADY_ACTIVE'
  | 'NO_TRANSACTION_TO_ROLLBACK'
  | 'TRANSACTION_START_FAILED'
  | 'TRANSACTION_ENDED_UNEXPECTEDLY';

export class TransactionalTestError extends Error {
  readonly code: TransactionalTestErrorCode;

  constructor(code: TransactionalTestErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransactionalTestError';
    this.code = code;
  }
}

export interface TransactionalTestHelper<TClient> {
  readonly client: TClient;
  startNewTransaction(): Promise<void>;
  rollbackCurrentTransaction(): Promise<void>;
}

type TransactionOf<TClient> = TClient extends TransactionClient<infer TTransaction>
  ? TTransaction
  : never;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly settled: () => boolean;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  let isSettled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value) {
      if (isSettled) return;
      isSettled = true;
      resolvePromise(value);
    },
    reject(reason) {
      if (isSettled) return;
      isSettled = true;
      rejectPromise(reason);
    },
    settled: () => isSettled,
  };
}

const ROLLBACK_SIGNAL = Symbol('prisma-transactional-testing.rollback');

type Session<TTransaction> = {
  phase: 'starting' | 'active' | 'rolling-back';
  transaction?: TTransaction;
  readonly activated: Deferred<void>;
  readonly rollbackRequested: Deferred<void>;
  completion?: Promise<void>;
};

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * Creates a stable client proxy whose operations are served by the helper's
 * currently active Prisma transaction.
 */
export function createTransactionalTestHelper<TClient extends TransactionClient>(
  originalClient: TClient,
): TransactionalTestHelper<TClient> {
  type TTransaction = TransactionOf<TClient>;
  let currentSession: Session<TTransaction> | undefined;

  const noActiveTransaction = () =>
    new TransactionalTestError(
      'NO_ACTIVE_TRANSACTION',
      'Cannot execute a Prisma operation without an active test transaction. Call startNewTransaction() first.',
    );

  const activeTransaction = (): TTransaction => {
    const session = currentSession;
    if (session?.phase !== 'active' || session.transaction === undefined) {
      throw noActiveTransaction();
    }
    return session.transaction;
  };

  const assertSessionIsActive = (session: Session<TTransaction>): void => {
    if (currentSession !== session || session.phase !== 'active') {
      throw noActiveTransaction();
    }
  };

  const wrapTransactionValue = <T>(value: T, session: Session<TTransaction>): T => {
    if (!isObjectLike(value)) return value;

    return new Proxy(value, {
      get(target, property) {
        assertSessionIsActive(session);
        const member = Reflect.get(target, property, target);
        if (typeof member !== 'function') {
          return wrapTransactionValue(member, session);
        }

        return (...args: unknown[]) => {
          assertSessionIsActive(session);
          return wrapTransactionValue(Reflect.apply(member, target, args), session);
        };
      },
      apply(target, thisArgument, argumentsList) {
        assertSessionIsActive(session);
        return wrapTransactionValue(
          Reflect.apply(target as (...args: unknown[]) => unknown, thisArgument, argumentsList),
          session,
        );
      },
    });
  };

  const resolvePath = (path: readonly PropertyKey[]): { receiver: object; member: unknown } => {
    let receiver: unknown = activeTransaction();

    for (let index = 0; index < path.length - 1; index += 1) {
      receiver = Reflect.get(receiver as object, path[index]!);
    }

    const property = path.at(-1);
    if (property === undefined) {
      return { receiver: originalClient, member: receiver };
    }

    return {
      receiver: receiver as object,
      member: Reflect.get(receiver as object, property),
    };
  };

  const makePathProxy = (path: readonly PropertyKey[]): unknown =>
    new Proxy(() => undefined, {
      get(_target, property) {
        return makePathProxy([...path, property]);
      },
      apply(_target, _thisArgument, argumentsList) {
        const session = currentSession;
        const { receiver, member } = resolvePath(path);
        if (typeof member !== 'function') {
          throw new TypeError(`Prisma client property ${path.map(String).join('.')} is not callable.`);
        }

        return wrapTransactionValue(Reflect.apply(member, receiver, argumentsList), session!);
      },
    });

  const client = makePathProxy([]) as TClient;

  const startNewTransaction = async (): Promise<void> => {
    if (currentSession !== undefined) {
      throw new TransactionalTestError(
        'TRANSACTION_ALREADY_ACTIVE',
        'Cannot start a test transaction while another transaction is active on this helper.',
      );
    }

    const session: Session<TTransaction> = {
      phase: 'starting',
      activated: deferred<void>(),
      rollbackRequested: deferred<void>(),
    };
    currentSession = session;

    let transactionPromise: Promise<unknown>;
    try {
      transactionPromise = originalClient.transaction(async (transaction) => {
        session.transaction = transaction as TTransaction;
        session.phase = 'active';
        session.activated.resolve(undefined);
        await session.rollbackRequested.promise;
        throw ROLLBACK_SIGNAL;
      });
    } catch (cause) {
      const error = new TransactionalTestError(
        'TRANSACTION_START_FAILED',
        'Prisma failed to start the test transaction.',
        { cause },
      );
      session.activated.reject(error);
      currentSession = undefined;
      throw error;
    }

    session.completion = transactionPromise
      .then(() => {
        throw new TransactionalTestError(
          'TRANSACTION_ENDED_UNEXPECTEDLY',
          'The Prisma test transaction ended before rollback was requested.',
        );
      })
      .catch((cause: unknown) => {
        if (cause !== ROLLBACK_SIGNAL) {
          throw new TransactionalTestError(
            session.activated.settled()
              ? 'TRANSACTION_ENDED_UNEXPECTEDLY'
              : 'TRANSACTION_START_FAILED',
            session.activated.settled()
              ? 'The Prisma test transaction ended unexpectedly.'
              : 'Prisma failed to start the test transaction.',
            { cause },
          );
        }
      })
      .finally(() => {
        if (currentSession === session) currentSession = undefined;
      });

    void session.completion.catch((error: unknown) => {
      session.activated.reject(error);
    });

    await session.activated.promise;
  };

  const rollbackCurrentTransaction = async (): Promise<void> => {
    const session = currentSession;
    if (session?.phase !== 'active' || session.completion === undefined) {
      throw new TransactionalTestError(
        'NO_TRANSACTION_TO_ROLLBACK',
        'Cannot roll back because this helper has no active test transaction.',
      );
    }

    session.phase = 'rolling-back';
    session.rollbackRequested.resolve(undefined);
    await session.completion;
  };

  return { client, startNewTransaction, rollbackCurrentTransaction };
}
