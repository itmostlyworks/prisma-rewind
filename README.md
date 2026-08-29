# prisma-transactional-testing

Framework-agnostic transaction isolation for PostgreSQL tests using Prisma 8.

> Prisma 8 is currently available as a release candidate. Development is pinned to
> `@prisma/orm-postgres@8.0.0-rc.8`; the package peer range targets the first stable
> Prisma 8 release (`>=8.0.0 <9`).

## Usage

```ts
import { createTransactionalTestHelper } from 'prisma-transactional-testing';
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
second transaction on the same helper also fails. Use a separate Prisma client and
helper for each concurrently active test transaction.

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
