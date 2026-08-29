---
id: TASK-1.3
title: 'Slice 3: Application code can run nested transactions'
status: Done
assignee: []
created_date: '2026-08-29 14:53'
updated_date: '2026-08-29 20:39'
labels: []
dependencies:
  - TASK-1.1
parent_task_id: TASK-1
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Part of TASK-1.

## What this slice delivers

Application code can open nested Prisma transactions while running inside a root test transaction, with PostgreSQL savepoint semantics and final rollback isolation.

## Out of scope for this slice

- Concurrent root transactions sharing one helper.
- Test-runner-specific adapters.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Work completed by client.transaction() inside a test transaction remains visible to the outer transaction and disappears when the outer transaction rolls back.
- [x] #2 If a nested transaction fails, its changes are rolled back while the outer test transaction remains usable and can continue.
- [x] #3 Multiple levels of nested transactions preserve savepoint boundaries and are all ultimately rolled back with the root test transaction.
- [x] #4 Nested transaction support does not permit a second overlapping root transaction on the same helper.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built
Added PostgreSQL savepoint-backed nested `client.transaction()` support to the stable helper proxy in `src/transactional-test-helper.ts`, with scoped transaction values and async-context guards that preserve savepoint ordering. Added unit and real PostgreSQL integration coverage for successful, failed, recursive, overlapping, detached, and root-rollback transaction behavior, plus README documentation.

## Decisions
- Used Prisma's public raw statement-plan and active transaction `execute()` surfaces because `@prisma/orm-postgres` 8.0.0-rc.8 does not expose `transaction()` on its transaction context.
- Reused one fixed internal savepoint name, relying on PostgreSQL's documented same-name savepoint stack semantics and avoiding dynamic SQL identifiers.
- Rejected overlapping sibling transactions, outer-scope operations during an active child, detached children, and root rollback during nesting so savepoint operations remain strictly ordered.

## Deferrals
- Concurrent root transactions sharing one helper and test-runner-specific adapters remain out of scope as planned.
<!-- SECTION:NOTES:END -->
