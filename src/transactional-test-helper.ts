import { AsyncLocalStorage } from 'node:async_hooks';

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
  | 'TRANSACTION_ENDED_UNEXPECTEDLY'
  | 'LIFECYCLE_OPERATION_DURING_TRANSACTION';

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

const STATIC_CLIENT_PROPERTIES = new Set<PropertyKey>(['raw', 'enums', 'nativeEnums']);
const LIFECYCLE_CLIENT_PROPERTIES = new Set<PropertyKey>([
  'connect',
  'close',
  Symbol.asyncDispose,
]);

type Session<TTransaction> = {
  phase: 'starting' | 'active' | 'rolling-back';
  transaction?: TTransaction;
  readonly activated: Deferred<void>;
  readonly rollbackRequested: Deferred<void>;
  completion?: Promise<void>;
};

type RawStatementTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  affectedCount(): { build(): unknown };
};

type TransactionExecutor = {
  execute(plan: unknown): PromiseLike<unknown>;
};

type NestedTransactionScope = {
  active: boolean;
  readonly completion: Deferred<void>;
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
  const nestedTransactionContext = new AsyncLocalStorage<NestedTransactionScope>();
  const nestedTransactionStack: NestedTransactionScope[] = [];

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

  const assertNestedScopeOwnsSavepoint = (): void => {
    const openScope = nestedTransactionStack.at(-1);
    if (openScope !== undefined && nestedTransactionContext.getStore() !== openScope) {
      throw new TransactionalTestError(
        'TRANSACTION_ALREADY_ACTIVE',
        'Cannot execute Prisma operations from an outer scope while a nested transaction is still active. Await the nested transaction first.',
      );
    }
  };

  const wrapTransactionValue = <T>(
    value: T,
    session: Session<TTransaction>,
    assertAdditionalScope = () => undefined,
  ): T => {
    if (!isObjectLike(value)) return value;

    const assertValueIsUsable = () => {
      assertSessionIsActive(session);
      assertAdditionalScope();
    };

    return new Proxy(value, {
      get(target, property) {
        assertValueIsUsable();
        const member = Reflect.get(target, property, target);
        if (typeof member !== 'function') {
          return wrapTransactionValue(member, session, assertAdditionalScope);
        }

        return (...args: unknown[]) => {
          assertValueIsUsable();
          return wrapTransactionValue(
            Reflect.apply(member, target, args),
            session,
            assertAdditionalScope,
          );
        };
      },
      apply(target, thisArgument, argumentsList) {
        assertValueIsUsable();
        return wrapTransactionValue(
          Reflect.apply(target as (...args: unknown[]) => unknown, thisArgument, argumentsList),
          session,
          assertAdditionalScope,
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

  const originalClientProperty = (property: PropertyKey): unknown => {
    const member = Reflect.get(originalClient, property, originalClient);
    if (typeof member !== 'function') return member;

    return (...args: unknown[]) => Reflect.apply(member, originalClient, args);
  };

  const lifecycleClientProperty = (property: PropertyKey): unknown => {
    const member = Reflect.get(originalClient, property, originalClient);
    if (typeof member !== 'function') return member;

    return (...args: unknown[]) => {
      if (currentSession !== undefined) {
        throw new TransactionalTestError(
          'LIFECYCLE_OPERATION_DURING_TRANSACTION',
          `Cannot call Prisma client lifecycle operation ${String(property)} while a test transaction is active. Roll it back first.`,
        );
      }

      const result = Reflect.apply(member, originalClient, args);
      if (property === 'connect') {
        return Promise.resolve(result).then(() => undefined);
      }
      return result;
    };
  };

  const makePathProxy = (path: readonly PropertyKey[]): unknown =>
    new Proxy(() => undefined, {
      get(_target, property) {
        if (path.length === 0) {
          if (STATIC_CLIENT_PROPERTIES.has(property)) return originalClientProperty(property);
          if (LIFECYCLE_CLIENT_PROPERTIES.has(property)) return lifecycleClientProperty(property);
        }

        return makePathProxy([...path, property]);
      },
      apply(_target, _thisArgument, argumentsList) {
        assertNestedScopeOwnsSavepoint();
        const session = currentSession;
        const { receiver, member } = resolvePath(path);
        if (typeof member !== 'function') {
          throw new TypeError(`Prisma client property ${path.map(String).join('.')} is not callable.`);
        }

        return wrapTransactionValue(Reflect.apply(member, receiver, argumentsList), session!);
      },
    });

  const savepointPlans = (() => {
    const raw = Reflect.get(originalClient, 'raw', originalClient);
    const rawSql = isObjectLike(raw) ? Reflect.get(raw, 'sql', raw) : undefined;
    if (typeof rawSql !== 'function') return undefined;

    const statement = rawSql as RawStatementTag;
    return {
      create: statement`SAVEPOINT prisma_transactional_testing`.affectedCount().build(),
      rollback: statement`ROLLBACK TO SAVEPOINT prisma_transactional_testing`
        .affectedCount()
        .build(),
      release: statement`RELEASE SAVEPOINT prisma_transactional_testing`
        .affectedCount()
        .build(),
    };
  })();

  const runNestedTransaction = async <TResult>(
    callback: (transaction: TTransaction) => PromiseLike<TResult>,
  ): Promise<TResult> => {
    const transaction = activeTransaction();
    const session = currentSession!;
    const parentScope = nestedTransactionContext.getStore();
    const openScope = nestedTransactionStack.at(-1);

    if (openScope !== undefined && parentScope !== openScope) {
      throw new TransactionalTestError(
        'TRANSACTION_ALREADY_ACTIVE',
        'Cannot overlap sibling nested transactions on one helper. Await each nested transaction before starting another.',
      );
    }

    const execute = isObjectLike(transaction)
      ? Reflect.get(transaction, 'execute', transaction)
      : undefined;
    if (typeof execute !== 'function' || savepointPlans === undefined) {
      throw new TypeError(
        'The active Prisma transaction does not expose the PostgreSQL statement APIs required for nested transactions.',
      );
    }

    const scope: NestedTransactionScope = {
      active: true,
      completion: deferred<void>(),
    };
    nestedTransactionStack.push(scope);
    const executor = transaction as TransactionExecutor;

    try {
      await executor.execute(savepointPlans.create);
      try {
        const scopedTransaction = wrapTransactionValue(transaction, session, () => {
          if (!scope.active) {
            throw new TypeError(
              'Cannot use a nested Prisma transaction after its callback has ended.',
            );
          }
          assertNestedScopeOwnsSavepoint();
        });
        const result = await nestedTransactionContext.run(scope, () =>
          callback(scopedTransaction),
        );

        let detachedChild = false;
        while (nestedTransactionStack.at(-1) !== scope) {
          detachedChild = true;
          await nestedTransactionStack.at(-1)!.completion.promise;
        }
        if (detachedChild) {
          throw new TransactionalTestError(
            'TRANSACTION_ALREADY_ACTIVE',
            'A nested transaction callback ended before its child transaction. Await every child transaction before returning.',
          );
        }

        scope.active = false;
        await executor.execute(savepointPlans.release);
        return result;
      } catch (cause) {
        scope.active = false;
        try {
          await executor.execute(savepointPlans.rollback);
          await executor.execute(savepointPlans.release);
        } catch (cleanupError) {
          throw new AggregateError(
            [cause, cleanupError],
            'A nested Prisma transaction failed and its savepoint could not be rolled back.',
          );
        }
        throw cause;
      }
    } finally {
      if (nestedTransactionStack.at(-1) === scope) nestedTransactionStack.pop();
      scope.completion.resolve(undefined);
    }
  };

  const originalMakePathProxy = makePathProxy;
  const client = new Proxy(originalMakePathProxy([]) as TClient, {
    get(target, property, receiver) {
      if (property === 'transaction') return runNestedTransaction;
      return Reflect.get(target, property, receiver);
    },
  });

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
    if (nestedTransactionStack.length > 0) {
      throw new TransactionalTestError(
        'TRANSACTION_ALREADY_ACTIVE',
        'Cannot roll back the root test transaction while a nested transaction is active. Await the nested transaction first.',
      );
    }

    session.phase = 'rolling-back';
    session.rollbackRequested.resolve(undefined);
    await session.completion;
  };

  return { client, startNewTransaction, rollbackCurrentTransaction };
}
