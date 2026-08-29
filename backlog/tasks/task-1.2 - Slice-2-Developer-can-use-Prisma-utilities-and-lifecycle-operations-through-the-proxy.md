---
id: TASK-1.2
title: >-
  Slice 2: Developer can use Prisma utilities and lifecycle operations through
  the proxy
status: Done
assignee: []
created_date: '2026-08-29 14:53'
updated_date: '2026-08-29 19:56'
labels: []
dependencies:
  - TASK-1.1
parent_task_id: TASK-1
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Part of TASK-1.

## What this slice delivers

A consumer can use supported Prisma non-query utilities and client lifecycle operations through the stable proxy while retaining strict transactional query isolation.

## Out of scope for this slice

- Nested application transactions and savepoint behavior.
- Concurrent root transactions sharing one helper.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Supported non-query helpers exposed by the original client remain callable through the proxy and preserve their expected results and calling context.
- [x] #2 Client lifecycle operations remain accessible through the proxy and behave clearly when their use conflicts with an active transaction.
- [x] #3 An operation capable of querying the database never falls back to the original client during an active transaction.
- [x] #4 Queries performed after supported utility or lifecycle interactions remain isolated and disappear on rollback.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built
Extended the stable Prisma proxy to expose `raw`, `enums`, and `nativeEnums`, and to support `connect`, `close`, and async disposal with active-transaction conflict protection. Added unit and PostgreSQL integration coverage plus public behavior documentation.

## Decisions
- Unknown and query-capable operations remain transaction-bound; only the explicitly safe static utility roots delegate to the original client.
- Lifecycle calls fail while any test transaction session exists.
- Proxied `connect()` performs the connection but suppresses Prisma's query-capable runtime result to prevent an isolation escape.

## Deferrals
- The PostgreSQL integration suite is implemented but was skipped locally because `TEST_DATABASE_URL` was not set.
<!-- SECTION:NOTES:END -->
