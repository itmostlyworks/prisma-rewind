---
id: TASK-1
title: Transactional testing for Prisma 8
status: Done
assignee: []
created_date: '2026-08-29 14:41'
updated_date: '2026-08-29 21:01'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

TypeScript developers using Prisma 8 with PostgreSQL lack a reusable way to isolate database tests transactionally. They must manually delete or truncate data, recreate databases, or build custom transaction wrappers.

## Why now

Prisma 8 introduces a new runtime and transaction API that is incompatible with existing Prisma Client helpers such as `@chax-at/transactional-prisma-testing`.

## Success criteria

- Developers can create a stable proxy and use `startNewTransaction()` and `rollbackCurrentTransaction()` in any test framework.
- Every Prisma operation that executes against the database is routed through the active test transaction.
- Rolling back leaves no test-created records behind.
- Application code can call `db.transaction()` inside the test transaction with correct savepoint semantics.
- Overlapping transactions on one helper fail clearly; parallel tests work through separate client/helper instances.
- Static helpers and client lifecycle operations remain usable without escaping transactional query isolation.

## Constraints

- PostgreSQL only.
- Framework-agnostic TypeScript API.
- One active transaction per helper.
- Development pins an exact Prisma 8 RC version.
- The first stable release supports `@prisma/orm-postgres >=8.0.0 <9`, tested against its minimum supported and latest Prisma 8 versions.
- Nested transaction support is required, but may be implemented as the final slice.

## Non-goals

- Other database engines.
- Creating, migrating, or resetting test databases.
- Test-data factories.
- Vitest, Jest, or Playwright-specific adapters.
- Concurrent test transactions sharing one helper.

## Design

### Contracts

- Public surface: a factory accepts a Prisma client and returns a typed helper containing:
  - `client`: one stable proxy whose identity does not change between test transactions.
  - `startNewTransaction()`: starts the helper’s root test transaction and rejects if one is already active.
  - `rollbackCurrentTransaction()`: rolls back the active root transaction.
- Isolation: database operations through the proxy require an active test transaction and must never fall back to the underlying client.
- Non-query Prisma utilities and lifecycle operations remain available through the proxy without providing an alternate path for database queries.
- Compatibility: PostgreSQL only; peer support is `@prisma/orm-postgres >=8.0.0 <9`, tested against the minimum supported and latest Prisma 8 releases.

### Architecture

- Transaction ownership: each helper owns at most one explicit root Prisma transaction.
- Query routing: the stable proxy dynamically delegates database operations to the active root transaction.
- Nested transactions: application calls to `client.transaction()` delegate through the active transaction, relying on Prisma/PostgreSQL savepoint semantics.
- Parallelism: separate client/helper instances are required for concurrently active test transactions.

### Out of scope for the skeleton

- Concrete factory and helper type names beyond the required transaction method names.
- Proxy implementation and operation-classification details.
- Error classes and exact error messages.
- Test-runner integrations.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## QA

Verdict: pass

### Checked
- Full assembled suite against local PostgreSQL: 25 passed (18 unit, 7 integration).
- Stable proxy identity, sequential root transactions, separate concurrent helpers, lifecycle guards, and rollback isolation.
- Successful, failed, recursive, overlapping, detached, and root-rollback nested transaction behavior.
- Raw transaction-control statements are blocked at root and nested execution paths, including interpolated/lowered plans, comments, quoted text, and carriage-return line endings.
- Unexpected root failures and synchronous startup failures surface their original cause and leave helper state reusable.
- TypeScript typecheck, ESLint, production build, and diff whitespace checks passed.
- Focused assembled-diff and security reviews completed; all concrete findings were addressed.

### Expected release condition
- Stable minimum/latest Prisma 8 compatibility remains intentionally pending because npm currently publishes only `@prisma/orm-postgres@8.0.0-rc.8`. The package documents the RC pin and the CI workflow records the stable matrix update required once Prisma 8 stable exists.

## Settlement

### Fixed now
- Prevented raw transaction-control SQL from escaping root rollback or colliding with nested savepoints.
- Preserved unexpected root transaction failures for cleanup callers and made failed helper state reusable.
- Added real PostgreSQL regression coverage and documented transaction-control behavior.

### Friction triage
- No additional drafts or follow-up fixes were identified beyond the expected stable Prisma 8 compatibility condition.
<!-- SECTION:NOTES:END -->
