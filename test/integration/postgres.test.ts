import { defineContract } from '@prisma/orm-postgres/contract-builder';
import postgres from '@prisma/orm-postgres/runtime';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTransactionalTestHelper } from '../../src/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const tableName = `ptt_record_${process.pid}`;

const contract = defineContract(
  {},
  ({ field, model }) => ({
    models: {
      Record: model('Record', {
        fields: {
          id: field.id.uuidv7String(),
          label: field.text(),
        },
      }).sql({ table: tableName }),
    },
  }),
);

const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('PostgreSQL transaction isolation', () => {
  const setupPool = new Pool({ connectionString: databaseUrl });
  const clients: Array<ReturnType<typeof postgres<typeof contract>>> = [];

  const newClient = () => {
    const client = postgres({
      contract,
      url: databaseUrl!,
      verifyMarker: false,
    });
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    await setupPool.query(
      `CREATE TABLE ${tableName} (id char(36) PRIMARY KEY, label text NOT NULL)`,
    );
  });

  afterAll(async () => {
    await Promise.all(clients.map(async (client) => client.close()));
    await setupPool.query(`DROP TABLE IF EXISTS ${tableName}`);
    await setupPool.end();
  });

  it('retains a stable proxy across transactions and removes writes on rollback', async () => {
    const original = newClient();
    const helper = createTransactionalTestHelper(original);
    const proxy = helper.client;

    await helper.startNewTransaction();
    try {
      const created = await proxy.orm.public!.Record.create({ label: 'temporary' });
      expect(await proxy.orm.public!.Record.select('id', 'label').all()).toEqual([created]);
    } finally {
      await helper.rollbackCurrentTransaction();
    }

    expect(helper.client).toBe(proxy);
    expect(
      (await setupPool.query(`SELECT label FROM ${tableName} ORDER BY label`)).rows,
    ).toEqual([]);

    await helper.startNewTransaction();
    try {
      await proxy.orm.public!.Record.create({ label: 'second transaction' });
    } finally {
      await helper.rollbackCurrentTransaction();
    }
    expect((await setupPool.query(`SELECT count(*)::int AS count FROM ${tableName}`)).rows).toEqual([
      { count: 0 },
    ]);
  });

  it('keeps concurrently active helpers separate and rolls both back', async () => {
    const first = createTransactionalTestHelper(newClient());
    const second = createTransactionalTestHelper(newClient());

    await Promise.all([first.startNewTransaction(), second.startNewTransaction()]);
    try {
      await Promise.all([
        first.client.orm.public!.Record.create({ label: 'first' }),
        second.client.orm.public!.Record.create({ label: 'second' }),
      ]);

      expect(
        (await first.client.orm.public!.Record.select('label').all()).map((row) => row.label),
      ).toEqual(['first']);
      expect(
        (await second.client.orm.public!.Record.select('label').all()).map((row) => row.label),
      ).toEqual(['second']);
    } finally {
      await Promise.all([
        first.rollbackCurrentTransaction(),
        second.rollbackCurrentTransaction(),
      ]);
    }
    expect((await setupPool.query(`SELECT count(*)::int AS count FROM ${tableName}`)).rows).toEqual([
      { count: 0 },
    ]);
  });
});
