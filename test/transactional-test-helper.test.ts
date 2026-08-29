import { describe, expect, it } from 'vitest';
import { createTransactionalTestHelper } from '../src/index.js';
import type { TransactionalTestError } from '../src/index.js';

type RecordRow = { id: number; label: string };
type FakeTransaction = {
  orm: {
    Record: {
      create(input: { label: string }): Promise<RecordRow>;
      all(): Promise<RecordRow[]>;
      builder(): { all(): Promise<RecordRow[]> };
    };
  };
};

type FakeClient = FakeTransaction & {
  readonly enums: { readonly Status: { readonly ACTIVE: 'ACTIVE' } };
  readonly nativeEnums: { readonly Priority: readonly ['low', 'high'] };
  readonly raw: {
    readonly prefix: string;
    sql(this: FakeClient['raw'], value: string): string;
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
      sql(value) {
        return `${this.prefix}:${value}`;
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
      const transaction: FakeTransaction = {
        orm: { Record: collectionFor(transactionalRows, false) },
      };
      const result = await callback(transaction);
      committed.splice(0, committed.length, ...transactionalRows);
      return result;
    },
  };

  return {
    client,
    committed,
    lifecycleCalls,
    originalQueryCalls: () => originalQueryCalls,
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
