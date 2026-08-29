import { describe, expect, it } from 'vitest';
import { createTransactionalTestHelper } from '../src/index.js';
import type { TransactionalTestError } from '../src/index.js';

type RecordRow = { id: number; label: string };
type FakeStatementPlan = {
  readonly statement: string;
  readonly ast: { readonly kind: 'raw-query'; readonly parts: readonly unknown[] };
  readonly sql?: string;
};
type FakeDataSurface = {
  orm: {
    Record: {
      create(input: { label: string }): Promise<RecordRow>;
      all(): Promise<RecordRow[]>;
      builder(): { all(): Promise<RecordRow[]> };
    };
  };
};

type FakeTransaction = FakeDataSurface & {
  execute(plan: FakeStatementPlan): Promise<void>;
};

type FakeClient = FakeDataSurface & {
  readonly enums: { readonly Status: { readonly ACTIVE: 'ACTIVE' } };
  readonly nativeEnums: { readonly Priority: readonly ['low', 'high'] };
  readonly raw: {
    readonly prefix: string;
    sql(
      this: FakeClient['raw'],
      value: string | TemplateStringsArray,
    ): string | { affectedCount(): { build(): FakeStatementPlan } };
  };
  connect(): Promise<{ readonly connected: true }>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
  transaction<TResult>(
    callback: (transaction: FakeTransaction) => PromiseLike<TResult>,
  ): Promise<TResult>;
};

function createFakeClient() {
  const committed: RecordRow[] = [];
  const lifecycleCalls: string[] = [];
  let originalQueryCalls = 0;
  let nextId = 1;
  let failCurrentTransaction: ((cause: unknown) => void) | undefined;

  const collectionFor = (
    rows: RecordRow[],
    original: boolean,
  ): FakeTransaction['orm']['Record'] => ({
    async create({ label }) {
      if (original) originalQueryCalls += 1;
      const row = { id: nextId++, label };
      rows.push(row);
      return row;
    },
    async all() {
      if (original) originalQueryCalls += 1;
      return [...rows];
    },
    builder() {
      if (original) originalQueryCalls += 1;
      return { all: async () => [...rows] };
    },
  });

  const client: FakeClient = {
    orm: { Record: collectionFor(committed, true) },
    enums: { Status: { ACTIVE: 'ACTIVE' } },
    nativeEnums: { Priority: ['low', 'high'] },
    raw: {
      prefix: 'raw',
      sql(value: string | TemplateStringsArray) {
        if (typeof value === 'string') return `${this.prefix}:${value}`;
        const statement = value.join('');
        return {
          affectedCount: () => ({
            build: () => ({ statement, ast: { kind: 'raw-query', parts: [statement] } }),
          }),
        };
      },
    },
    async connect() {
      lifecycleCalls.push('connect');
      return { connected: true } as const;
    },
    async close() {
      lifecycleCalls.push('close');
    },
    async [Symbol.asyncDispose]() {
      lifecycleCalls.push('asyncDispose');
    },
    async transaction(callback) {
      const transactionalRows = structuredClone(committed);
      const savepoints: RecordRow[][] = [];
      const transaction: FakeTransaction = {
        async execute({ statement }) {
          if (statement.startsWith('SAVEPOINT ')) {
            savepoints.push(structuredClone(transactionalRows));
          } else if (statement.startsWith('ROLLBACK TO SAVEPOINT ')) {
            const rows = savepoints.at(-1);
            if (rows === undefined) throw new Error('No fake savepoint to roll back.');
            transactionalRows.splice(0, transactionalRows.length, ...structuredClone(rows));
          } else if (statement.startsWith('RELEASE SAVEPOINT ')) {
            if (savepoints.pop() === undefined) throw new Error('No fake savepoint to release.');
          } else {
            throw new Error(`Unknown fake transaction statement: ${statement}`);
          }
        },
        orm: { Record: collectionFor(transactionalRows, false) },
      };
      const forcedFailure = new Promise<never>((_resolve, reject) => {
        failCurrentTransaction = reject;
      });
      const result = await Promise.race([callback(transaction), forcedFailure]);
      committed.splice(0, committed.length, ...transactionalRows);
      return result;
    },
  };

  return {
    client,
    committed,
    lifecycleCalls,
    originalQueryCalls: () => originalQueryCalls,
    failTransaction(cause: unknown) {
      if (failCurrentTransaction === undefined) throw new Error('No transaction is active.');
      failCurrentTransaction(cause);
    },
  };
}

describe('createTransactionalTestHelper', () => {
  it('keeps one proxy across sequential transactions and rolls back writes', async () => {
    const { client, committed } = createFakeClient();
    const helper = createTransactionalTestHelper(client);
    const proxy = helper.client;

    await helper.startNewTransaction();
    await proxy.orm.Record.create({ label: 'first' });
    expect(await proxy.orm.Record.all()).toEqual([{ id: 1, label: 'first' }]);
    await helper.rollbackCurrentTransaction();

    expect(committed).toEqual([]);
    expect(helper.client).toBe(proxy);

    await helper.startNewTransaction();
    await proxy.orm.Record.create({ label: 'second' });
    expect(await proxy.orm.Record.all()).toEqual([{ id: 2, label: 'second' }]);
    await helper.rollbackCurrentTransaction();

    expect(committed).toEqual([]);
  });

  it('rejects queries without an active transaction and overlapping starts', async () => {
    const { client } = createFakeClient();
    const helper = createTransactionalTestHelper(client);

    expect(() => helper.client.orm.Record.all()).toThrowError(
      expect.objectContaining<Partial<TransactionalTestError>>({
        code: 'NO_ACTIVE_TRANSACTION',
        message: expect.stringContaining('startNewTransaction()'),
      }),
    );

    await helper.startNewTransaction();
    await expect(helper.startNewTransaction()).rejects.toMatchObject({
      code: 'TRANSACTION_ALREADY_ACTIVE',
      message: expect.stringContaining('another transaction is active'),
    });
    await helper.rollbackCurrentTransaction();
  });

  it('exposes supported static utilities with their result and calling context', async () => {
    const { client } = createFakeClient();
    const helper = createTransactionalTestHelper(client);

    expect(helper.client.raw.sql('fragment')).toBe('raw:fragment');
    expect(helper.client.raw).toBe(client.raw);
    expect(helper.client.enums).toBe(client.enums);
    expect(helper.client.nativeEnums).toBe(client.nativeEnums);

    await helper.startNewTransaction();
    expect(helper.client.raw.sql('inside')).toBe('raw:inside');
    await helper.rollbackCurrentTransaction();
  });

  it('delegates lifecycle operations only when no test transaction is active', async () => {
    const { client, lifecycleCalls } = createFakeClient();
    const helper = createTransactionalTestHelper(client);

    await expect(helper.client.connect()).resolves.toBeUndefined();
    await helper.startNewTransaction();

    expect(() => helper.client.close()).toThrowError(
      expect.objectContaining<Partial<TransactionalTestError>>({
        code: 'LIFECYCLE_OPERATION_DURING_TRANSACTION',
        message: expect.stringContaining('Roll it back first'),
      }),
    );
    expect(() => helper.client[Symbol.asyncDispose]()).toThrowError(
      expect.objectContaining({ code: 'LIFECYCLE_OPERATION_DURING_TRANSACTION' }),
    );

    await helper.rollbackCurrentTransaction();
    await helper.client.close();
    await helper.client[Symbol.asyncDispose]();
    expect(lifecycleCalls).toEqual(['connect', 'close', 'asyncDispose']);
  });

  it('blocks raw transaction-control SQL without rejecting harmless SQL text', async () => {
    const { client } = createFakeClient();
    const helper = createTransactionalTestHelper(client);
    const execute = (helper.client as unknown as FakeTransaction).execute;
    const plan = (sql: TemplateStringsArray) =>
      helper.client.raw.sql(sql) as { affectedCount(): { build(): FakeStatementPlan } };
    const interpolatedCommitPlan: FakeStatementPlan = {
      statement: 'SELECT $1; COMMIT',
      ast: { kind: 'raw-query', parts: ['SELECT ', { param: 0 }, '; COMMIT'] },
    };

    await helper.startNewTransaction();
    await expect(
      execute(plan`SELECT 'COMMIT'`.affectedCount().build()),
    ).rejects.toThrow('Unknown fake transaction statement');
    expect(() => execute(plan`SELECT 1; /* escape */ COMMIT`.affectedCount().build())).toThrowError(
      expect.objectContaining<Partial<TransactionalTestError>>({
        code: 'UNSAFE_TRANSACTION_CONTROL',
        message: expect.stringContaining('rollback isolation'),
      }),
    );
    expect(() => execute(plan`ROLLBACK TO SAVEPOINT other`.affectedCount().build())).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_TRANSACTION_CONTROL' }),
    );
    expect(() => execute(interpolatedCommitPlan)).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_TRANSACTION_CONTROL' }),
    );
    expect(() => execute({ ...interpolatedCommitPlan, sql: 'COMMIT' })).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_TRANSACTION_CONTROL' }),
    );
    expect(() => execute(plan`-- comment\rCOMMIT`.affectedCount().build())).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_TRANSACTION_CONTROL' }),
    );
    await expect(
      execute(plan`SELECT E'not over \\'; COMMIT is still text'`.affectedCount().build()),
    ).rejects.toThrow('Unknown fake transaction statement');
    await helper.client.transaction(async (transaction) => {
      expect(() => transaction.execute(plan`COMMIT`.affectedCount().build())).toThrowError(
        expect.objectContaining({ code: 'UNSAFE_TRANSACTION_CONTROL' }),
      );
    });
    await helper.rollbackCurrentTransaction();
  });

  it('surfaces an unexpected root failure when rollback is requested', async () => {
    const fake = createFakeClient();
    const helper = createTransactionalTestHelper(fake.client);

    await helper.startNewTransaction();
    fake.failTransaction(new Error('connection lost'));

    await expect(helper.rollbackCurrentTransaction()).rejects.toMatchObject({
      code: 'TRANSACTION_ENDED_UNEXPECTEDLY',
      cause: expect.objectContaining({ message: 'connection lost' }),
    });
    await expect(helper.startNewTransaction()).resolves.toBeUndefined();
    await helper.rollbackCurrentTransaction();
  });

  it('reports synchronous root startup failures without retaining a session', async () => {
    const fake = createFakeClient();
    const startupFailure = new Error('synchronous startup failure');
    fake.client.transaction = () => {
      throw startupFailure;
    };
    const helper = createTransactionalTestHelper(fake.client);

    await expect(helper.startNewTransaction()).rejects.toMatchObject({
      code: 'TRANSACTION_START_FAILED',
      cause: startupFailure,
    });
    await expect(helper.startNewTransaction()).rejects.toMatchObject({
      code: 'TRANSACTION_START_FAILED',
    });
  });

  it('never falls back to the original client for queries during a transaction', async () => {
    const { client, originalQueryCalls } = createFakeClient();
    const helper = createTransactionalTestHelper(client);

    await helper.startNewTransaction();
    await helper.client.orm.Record.create({ label: 'transaction only' });
    expect(await helper.client.orm.Record.all()).toHaveLength(1);
    expect(originalQueryCalls()).toBe(0);
    await helper.rollbackCurrentTransaction();
  });

  it('keeps queries isolated after utility and lifecycle interactions', async () => {
    const { client, committed } = createFakeClient();
    const helper = createTransactionalTestHelper(client);

    await helper.client.connect();
    expect(helper.client.raw.sql('before query')).toBe('raw:before query');
    await helper.startNewTransaction();
    await helper.client.orm.Record.create({ label: 'temporary' });
    expect(helper.client.enums.Status.ACTIVE).toBe('ACTIVE');
    await helper.rollbackCurrentTransaction();

    expect(committed).toEqual([]);
  });

  it('prevents a builder captured from a transaction from being used after rollback', async () => {
    const { client } = createFakeClient();
    const helper = createTransactionalTestHelper(client);

    await helper.startNewTransaction();
    const builder = helper.client.orm.Record.builder();
    await helper.rollbackCurrentTransaction();

    expect(() => builder.all()).toThrowError(
      expect.objectContaining({ code: 'NO_ACTIVE_TRANSACTION' }),
    );
  });

  it('keeps successful nested work visible until the root transaction rolls back', async () => {
    const { client, committed } = createFakeClient();
    const helper = createTransactionalTestHelper(client);

    await helper.startNewTransaction();
    await helper.client.orm.Record.create({ label: 'outer' });
    await helper.client.transaction(async (transaction) => {
      await transaction.orm.Record.create({ label: 'nested' });
      await expect(helper.startNewTransaction()).rejects.toMatchObject({
        code: 'TRANSACTION_ALREADY_ACTIVE',
      });
    });

    expect((await helper.client.orm.Record.all()).map((row) => row.label)).toEqual([
      'outer',
      'nested',
    ]);
    await helper.rollbackCurrentTransaction();
    expect(committed).toEqual([]);
  });

  it('rolls back failed nested work and leaves the outer transaction usable', async () => {
    const { client, committed } = createFakeClient();
    const helper = createTransactionalTestHelper(client);

    await helper.startNewTransaction();
    await helper.client.orm.Record.create({ label: 'before' });
    await expect(
      helper.client.transaction(async (transaction) => {
        await transaction.orm.Record.create({ label: 'discarded' });
        throw new Error('nested failure');
      }),
    ).rejects.toThrow('nested failure');
    await helper.client.orm.Record.create({ label: 'after' });

    expect((await helper.client.orm.Record.all()).map((row) => row.label)).toEqual([
      'before',
      'after',
    ]);
    await helper.rollbackCurrentTransaction();
    expect(committed).toEqual([]);
  });

  it('invalidates values captured from a completed nested transaction', async () => {
    const { client } = createFakeClient();
    const helper = createTransactionalTestHelper(client);

    await helper.startNewTransaction();
    const captured: { builder?: ReturnType<FakeTransaction['orm']['Record']['builder']> } = {};
    await helper.client.transaction(async (transaction) => {
      captured.builder = transaction.orm.Record.builder();
    });

    expect(() => captured.builder!.all()).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('nested Prisma transaction'),
      }),
    );
    await helper.rollbackCurrentTransaction();
  });

  it('rejects overlapping sibling nested transactions', async () => {
    const { client } = createFakeClient();
    const helper = createTransactionalTestHelper(client);
    let signalEntered!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    await helper.startNewTransaction();
    const first = helper.client.transaction(async () => {
      signalEntered();
      await waitForRelease;
    });
    await entered;

    await expect(helper.client.transaction(async () => undefined)).rejects.toMatchObject({
      code: 'TRANSACTION_ALREADY_ACTIVE',
      message: expect.stringContaining('overlap sibling nested transactions'),
    });
    releaseFirst();
    await first;
    await helper.rollbackCurrentTransaction();
  });

  it('rejects root rollback until the active nested transaction settles', async () => {
    const { client } = createFakeClient();
    const helper = createTransactionalTestHelper(client);
    let signalEntered!: () => void;
    let releaseNested!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });

    await helper.startNewTransaction();
    const nested = helper.client.transaction(async () => {
      signalEntered();
      await waitForRelease;
    });
    await entered;

    await expect(helper.rollbackCurrentTransaction()).rejects.toMatchObject({
      code: 'TRANSACTION_ALREADY_ACTIVE',
      message: expect.stringContaining('nested transaction is active'),
    });
    releaseNested();
    await nested;
    await expect(helper.rollbackCurrentTransaction()).resolves.toBeUndefined();
  });

  it('rejects outer work and cleans up when a child transaction is not awaited', async () => {
    const { client } = createFakeClient();
    const helper = createTransactionalTestHelper(client);
    let childResult: Promise<unknown> | undefined;

    await helper.startNewTransaction();
    await expect(
      helper.client.transaction(async (outerNested) => {
        childResult = helper.client
          .transaction(async (innerNested) => {
            await innerNested.orm.Record.create({ label: 'detached child' });
          })
          .catch((error: unknown) => error);

        expect(() => outerNested.orm.Record.all()).toThrowError(
          expect.objectContaining({
            code: 'TRANSACTION_ALREADY_ACTIVE',
            message: expect.stringContaining('Await the nested transaction'),
          }),
        );
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_ALREADY_ACTIVE',
      message: expect.stringContaining('ended before its child transaction'),
    });
    await childResult;

    await helper.client.orm.Record.create({ label: 'root remains usable' });
    expect((await helper.client.orm.Record.all()).map((row) => row.label)).toEqual([
      'root remains usable',
    ]);
    await helper.rollbackCurrentTransaction();
  });

  it('preserves savepoint boundaries across multiple nested levels', async () => {
    const { client, committed } = createFakeClient();
    const helper = createTransactionalTestHelper(client);

    await helper.startNewTransaction();
    await helper.client.transaction(async (outerNested) => {
      await outerNested.orm.Record.create({ label: 'level one' });
      await expect(
        helper.client.transaction(async (innerNested) => {
          await innerNested.orm.Record.create({ label: 'level two discarded' });
          throw new Error('inner failure');
        }),
      ).rejects.toThrow('inner failure');
      await outerNested.orm.Record.create({ label: 'level one continued' });
    });

    expect((await helper.client.orm.Record.all()).map((row) => row.label)).toEqual([
      'level one',
      'level one continued',
    ]);
    await helper.rollbackCurrentTransaction();
    expect(committed).toEqual([]);
  });

  it('isolates concurrent transactions owned by separate helpers', async () => {
    const first = createFakeClient();
    const second = createFakeClient();
    const firstHelper = createTransactionalTestHelper(first.client);
    const secondHelper = createTransactionalTestHelper(second.client);

    await Promise.all([
      firstHelper.startNewTransaction(),
      secondHelper.startNewTransaction(),
    ]);
    await Promise.all([
      firstHelper.client.orm.Record.create({ label: 'first helper' }),
      secondHelper.client.orm.Record.create({ label: 'second helper' }),
    ]);

    expect(await firstHelper.client.orm.Record.all()).toEqual([
      { id: 1, label: 'first helper' },
    ]);
    expect(await secondHelper.client.orm.Record.all()).toEqual([
      { id: 1, label: 'second helper' },
    ]);

    await Promise.all([
      firstHelper.rollbackCurrentTransaction(),
      secondHelper.rollbackCurrentTransaction(),
    ]);
    expect(first.committed).toEqual([]);
    expect(second.committed).toEqual([]);
  });
});
