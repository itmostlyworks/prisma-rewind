# @mostlyworks/prisma-rewind

Framework-agnostic transaction isolation for PostgreSQL tests using Prisma 8.

```sh
npm install --save-dev @mostlyworks/prisma-rewind
```

> Prisma 8 is currently available as a release candidate. Development is pinned to
> `@prisma/orm-postgres@8.0.0-rc.8`; the package peer range supports that release
> candidate and subsequent Prisma 8 releases (`>=8.0.0-rc.8 <9`).

## Usage

```ts
import { createTransactionalTestHelper } from '@mostlyworks/prisma-rewind';
import { db } from './prisma/db.js';

const testDb = createTransactionalTestHelper(db);

await testDb.startNewTransaction();
try {
  await testDb.client.orm.public.User.create({ email: 'test@example.com' });
  // Run assertions using the same stable testDb.client proxy.
} finally {
  await testDb.rollbackCurrentTransaction();
}
```

Database operations through `client` require an active test transaction. Starting a
second root transaction on the same helper also fails. Use a separate Prisma client and
helper for each concurrently active test transaction.

Application code can call `client.transaction()` while the root test transaction is
active. Successful nested work remains visible to the outer transaction, while a thrown
error rolls nested work back to a PostgreSQL savepoint and leaves the outer transaction
usable. Nested work is still removed by `rollbackCurrentTransaction()`.

The proxy exposes Prisma's non-query `raw`, `enums`, and `nativeEnums` utilities
without requiring a transaction. Client lifecycle methods (`connect`, `close`, and
async disposal) delegate to the original client when no test transaction exists and
fail clearly while one is active. The proxied `connect()` resolves to `undefined`
instead of exposing Prisma's query-capable runtime. Unknown operations remain
transaction-bound so a query-capable API can never silently fall back to the original
client. Raw transaction-control statements such as `COMMIT`, `ROLLBACK`, and `SAVEPOINT`
are rejected when executed through the proxy because they could escape the helper's root
rollback or interfere with nested savepoints.

## Development

```sh
npm install
npm test
npm run tc
npm run lint
```

PostgreSQL integration tests run when `TEST_DATABASE_URL` is set:

```sh
TEST_DATABASE_URL=postgresql://localhost/postgres npm test
```
