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
  transaction<TResult>(
    callback: (transaction: FakeTransaction) => PromiseLike<TResult>,
  ): Promise<TResult>;
};

function createFakeClient() {
  const committed: RecordRow[] = [];
  let nextId = 1;

  const collectionFor = (rows: RecordRow[]): FakeTransaction['orm']['Record'] => ({
    async create({ label }) {
      const row = { id: nextId++, label };
      rows.push(row);
      return row;
    },
    async all() {
      return [...rows];
    },
    builder() {
      return { all: async () => [...rows] };
    },
  });

  const client: FakeClient = {
    orm: { Record: collectionFor(committed) },
    async transaction(callback) {
      const transactionalRows = structuredClone(committed);
      const transaction: FakeTransaction = {
        orm: { Record: collectionFor(transactionalRows) },
      };
      const result = await callback(transaction);
      committed.splice(0, committed.length, ...transactionalRows);
      return result;
    },
  };

  return { client, committed };
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
