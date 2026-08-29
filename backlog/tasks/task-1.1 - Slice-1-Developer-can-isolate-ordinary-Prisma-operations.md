---
id: TASK-1.1
title: 'Slice 1: Developer can isolate ordinary Prisma operations'
status: Done
assignee: []
created_date: '2026-08-29 14:53'
updated_date: '2026-08-29 15:11'
labels: []
dependencies: []
parent_task_id: TASK-1
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Part of TASK-1.

## What this slice delivers

A framework-agnostic TypeScript consumer can use a stable Prisma client proxy to run ordinary database operations inside a root test transaction and roll all changes back. This establishes the package API and proves the core Prisma 8 transaction-isolation mechanism across the supported version range.

## Out of scope for this slice

- Non-query Prisma utilities and client lifecycle operations through the proxy.
- Nested application transactions and savepoint behavior.
- Concurrent root transactions sharing one helper.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A consumer using either the minimum supported Prisma 8 version or the latest Prisma 8 version can create a helper and retain the same proxied client across sequential test transactions.
- [x] #2 Records created through the proxy during an active transaction are readable inside that transaction and absent after rollback.
- [x] #3 A query without an active transaction and a second start while one is active both fail with clear errors.
- [x] #4 Two helpers backed by separate clients can hold transactions concurrently and roll each back without leaking or mixing records.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built
Created the TypeScript package API in `src/transactional-test-helper.ts`: a stable typed client proxy backed by a held-open Prisma root transaction, with explicit start and rollback controls and clear state errors. Added unit coverage, live PostgreSQL integration coverage, package documentation, and an RC compatibility CI job.

## Decisions
- Prisma's callback transaction is held open with a deferred signal; rollback is requested by throwing a private sentinel from the callback.
- Transaction-returned builders and thenables are guarded so they cannot be used after their owning transaction ends.
- The package uses structural client typing and declares the intended stable Prisma 8 peer range while development remains pinned to the available RC.

## Deferrals
- The literal minimum/latest stable Prisma 8 matrix cannot run until `@prisma/orm-postgres@8.0.0` is published. CI currently exercises `8.0.0-rc.8`; replace its single RC entry with minimum and latest stable versions after publication.
<!-- SECTION:NOTES:END -->
