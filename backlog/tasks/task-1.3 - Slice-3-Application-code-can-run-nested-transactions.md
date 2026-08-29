---
id: TASK-1.3
title: 'Slice 3: Application code can run nested transactions'
status: To Do
assignee: []
created_date: '2026-08-29 14:53'
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
- [ ] #1 Work completed by client.transaction() inside a test transaction remains visible to the outer transaction and disappears when the outer transaction rolls back.
- [ ] #2 If a nested transaction fails, its changes are rolled back while the outer test transaction remains usable and can continue.
- [ ] #3 Multiple levels of nested transactions preserve savepoint boundaries and are all ultimately rolled back with the root test transaction.
- [ ] #4 Nested transaction support does not permit a second overlapping root transaction on the same helper.
<!-- AC:END -->
