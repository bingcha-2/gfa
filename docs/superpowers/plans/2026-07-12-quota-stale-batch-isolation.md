# Quota Stale-Batch Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain live lease attribution and isolate stale quota revisions without increasing normal SQLite transaction frequency.

**Architecture:** Keep the current batch transaction as the fast path. On `QUOTA_STALE_REVISION`, remove the reported stale key, retry remaining checkpoints as a batch, then let the coordinator resolve healthy waiters and reject only stale waiters.

**Tech Stack:** TypeScript, Vitest, Prisma, SQLite.

---

### Task 1: Verify live-lease retention

**Files:**
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts`
- Test: `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts`

- [x] Add a regression test that reports once, advances twelve minutes while the forty-minute lease remains valid, runs cleanup, and reports again through the same lease.
- [x] Require both causal retention expiry and lease expiry before deleting a completed mapping.
- [x] Run the complete LeaseService spec and require all tests green.

### Task 2: Isolate stale repository entries

**Files:**
- Modify: `apps/server/src/leasing/quota/fair-share-window-repository.ts`
- Test: `apps/server/src/leasing/quota/fair-share-window-repository.spec.ts`

- [x] Keep the existing one-transaction batch attempt for the normal path.
- [x] On `QuotaStaleRevisionError`, accumulate its key, remove that checkpoint, and retry remaining checkpoints together.
- [x] After healthy checkpoints commit, throw one aggregate stale error containing exactly the rejected keys.
- [x] Verify stale heads/receipts remain untouched while healthy heads/receipts/hourly accounting persist.

### Task 3: Resolve coordinator waiters per key

**Files:**
- Modify: `apps/server/src/leasing/quota/quota-write-coordinator.ts`
- Test: `apps/server/src/leasing/quota/quota-write-coordinator.spec.ts`

- [x] Add a failing test where commit reports one stale key and verify the healthy waiter resolves while the stale waiter rejects.
- [x] Teach the coordinator to recognize `code=QUOTA_STALE_REVISION` plus `staleKeys`; update `persisted` only for healthy entries.
- [x] Preserve all-fail behavior for ordinary database errors.
- [x] Verify a later healthy revision is not re-poisoned by the stale sibling.

### Task 4: Regression and handoff

**Files:**
- Update: `docs/superpowers/plans/2026-07-12-quota-stale-batch-isolation.md`

- [x] Run repository, coordinator, LeaseService, fair-share tracker, and quota report-ordering specs (14 files / 239 tests).
- [x] Run the full quota E2E matrix.
- [x] Run `pnpm test` (server 1,848; frontend 243; shared 16; worker unit/integration/E2E 28/13/3; Go, pricing, lint all green).
- [x] Run `git diff --check`, inspect the final diff, mark this plan complete, and commit the fixes.
