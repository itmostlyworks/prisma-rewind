---
id: TASK-1.2
title: >-
  Slice 2: Developer can use Prisma utilities and lifecycle operations through
  the proxy
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

A consumer can use supported Prisma non-query utilities and client lifecycle operations through the stable proxy while retaining strict transactional query isolation.

## Out of scope for this slice

- Nested application transactions and savepoint behavior.
- Concurrent root transactions sharing one helper.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Supported non-query helpers exposed by the original client remain callable through the proxy and preserve their expected results and calling context.
- [ ] #2 Client lifecycle operations remain accessible through the proxy and behave clearly when their use conflicts with an active transaction.
- [ ] #3 An operation capable of querying the database never falls back to the original client during an active transaction.
- [ ] #4 Queries performed after supported utility or lifecycle interactions remain isolated and disappear on rollback.
<!-- AC:END -->
