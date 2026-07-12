# Quota Final Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the bounded quota accounting rollout without pausing traffic, growing SQLite with a per-request ledger, or losing client history.

**Architecture:** Keep the 10-minute causal tail only in memory, persist a materialized compact checkpoint, and fail closed on persistence conflicts. Reuse the existing lease map, readiness barrier, blood-bar store, and 72-hour diagnostic tables with bounded recovery behavior.

**Tech Stack:** TypeScript, NestJS, Prisma/SQLite, Vitest, Go, Wails client, Node cross-process E2E.

---

### Task 1: Bounded in-memory causal tail and compact checkpoints

**Files:**
- Modify: `apps/server/src/leasing/quota/fair-share-window.ts`
- Modify: `apps/server/src/leasing/quota/window-cu-fair-share-engine.ts`
- Modify: `apps/server/src/leasing/quota/fair-share-window-repository.ts`
- Test: `apps/server/src/leasing/quota/fair-share-window.spec.ts`
- Test: `apps/server/src/leasing/quota/fair-share-window-repository.spec.ts`

- [ ] Write failing tests asserting 10,000/1 MiB bounds, capacity reason metadata, in-order fast-path equality with full replay, and persisted `reorderTail=[]` with unchanged materialized accounting.
- [ ] Run `pnpm --dir apps/server exec vitest run src/leasing/quota/fair-share-window.spec.ts src/leasing/quota/fair-share-window-repository.spec.ts`; confirm failures are the old constants/full-tail persistence.
- [ ] Set `REORDER_MAX_EVENTS = 10_000`, `REORDER_MAX_BYTES = 1024 * 1024`, track tail byte/count diagnostics, add an append fast path for causally ordered events, and expose a checkpoint compactor that copies the materialized core into `base` with an empty tail.
- [ ] Add the 128 MiB process budget to `WindowCuFairShareEngine`; collapse the oldest tails when exceeded and retain the compaction reason.
- [ ] Make repository serialization use compact checkpoint states while summaries still use the materialized subject values.
- [ ] Re-run focused tests and commit `fix(quota): bound causal replay without inflating sqlite`.

### Task 2: Revision conflicts and exact receipt acknowledgement

**Files:**
- Modify: `apps/server/src/leasing/quota/fair-share-window-repository.ts`
- Modify: `apps/server/src/leasing/quota/quota-write-coordinator.ts`
- Test: `apps/server/src/leasing/quota/fair-share-window-repository.spec.ts`
- Test: `apps/server/src/leasing/quota/quota-write-coordinator.spec.ts`
- Modify: `tests/quota-e2e/run.mjs`

- [ ] Write a failing repository test that places a newer head in SQLite and expects the stale checkpoint to reject without receipt/accounting writes.
- [ ] Run the focused specs and verify the stale call currently resolves.
- [ ] Add a typed stale-revision error and throw inside the transaction so partial scope writes roll back; coordinator waiters must reject and must never mark the revision persisted.
- [ ] Change the E2E stale-checkpoint scenario to expect failure and verify a client report is not acknowledged when its state did not commit.
- [ ] Run repository/coordinator specs and quota E2E; commit `fix(quota): reject stale checkpoint acknowledgements`.

### Task 3: Long-request attribution without time guessing

**Files:**
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts`
- Test: `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts`
- Modify: `tests/quota-e2e/run.mjs`

- [ ] Replace the current counter-test with a failing case that advances beyond `expiresAt + 35m`, triggers cleanup, then completes recently and must still attribute to the original account.
- [ ] Add a failing test that completed mappings survive the 10-minute reorder window then expire, and that more than 100,000 abandoned expired mappings evict the oldest first without touching active leases.
- [ ] Keep unreported expired lease mappings, mark terminal reports complete, delete completed mappings after the 10-minute reorder window, and enforce the count cap during cleanup.
- [ ] Extend cross-process E2E with a completion beyond the former grace threshold.
- [ ] Run lease-service specs and quota E2E; commit `fix(lease): retain attribution until report completion`.

### Task 4: Startup readiness must include durable reconciliation

**Files:**
- Modify: `apps/server/src/leasing/token-server/access-key-store.ts`
- Modify: `apps/server/src/leasing/token-server/token-server.service.ts`
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts`
- Test: `apps/server/src/leasing/token-server/__tests__/token-server.service.spec.ts`
- Test: `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts`
- Modify: `apps/server/src/leasing/quota/__tests__/quota-e2e-test-control.controller.ts`
- Modify: `tests/quota-e2e/run.mjs`

- [ ] Write failing tests for one rejected subscription `findMany`, delayed retry, 503 during the barrier, and readiness only after deferred reconciliation flush resolves.
- [ ] Write a failing test that fair-share `load()` rejection rejects module initialization rather than serving empty state.
- [ ] Make readiness callbacks asynchronous and set ready only after all callbacks resolve; retain callbacks after failure for the next retry.
- [ ] Track and cancel the subscription retry timer on module destruction; rethrow quota-state load failure.
- [ ] Add a boot-time E2E fault hook that fails the real subscription query once instead of manually toggling the flag.
- [ ] Run focused tests and quota E2E; commit `fix(quota): gate startup on durable quota recovery`.

### Task 5: Client session clearing without deleting history

**Files:**
- Modify: `apps/app/app.go`
- Modify: `apps/app/bloodbar.go`
- Modify: `apps/app/leaser_status.go`
- Test: `apps/app/app_switchcard_test.go`
- Test: `apps/app/user_auth_test.go`
- Test: `apps/app/bloodbar_test.go`
- Modify: `apps/app/quota_client_server_e2e_test.go`

- [ ] Change auth-transition tests to assert blood bars clear while `UsageStats` and its on-disk file remain intact; run them and confirm the current reset fails.
- [ ] Add failing old-server response tests where `personalFraction` disappears and both primary/weekly personal flags must clear.
- [ ] Split session quota clearing from explicit usage-history reset and use the non-destructive path for login/logout/forced logout/token changes.
- [ ] Add clear-personal helpers and clear absent personal fields for every bucket represented by the response.
- [ ] Run `go test ./... -count=1`; commit `fix(app): isolate quota session state from usage history`.

### Task 6: Recoverable diagnostics and quota reasons

**Files:**
- Modify: `apps/server/src/leasing/token-server/request-log-tracker.ts`
- Test: `apps/server/src/leasing/token-server/__tests__/request-log-tracker.spec.ts`
- Modify: `apps/server/src/leasing/token-server/fair-share-tracker.ts`
- Modify: `apps/server/src/leasing/lease-core/fair-share-message.ts`
- Test: `apps/server/src/leasing/lease-core/fair-share-message.spec.ts`
- Test: `apps/server/src/leasing/quota/fair-share-window.spec.ts`

- [ ] Write a failing request-log test proving a failed `createMany` batch is requeued within `QUEUE_MAX` and increments observable loss only when trimming is required.
- [ ] Write failing quota tests for compaction diagnostic fields and `account_recovering` when personal remaining is positive but mother remaining is zero.
- [ ] Requeue failed log batches, preserve the 72-hour/500,000-row policy, and expose compaction count/bytes through existing quota diagnostics.
- [ ] Add the `account_recovering` reason and Chinese message `上游额度恢复中，请稍后重试`.
- [ ] Run focused tests; commit `fix(quota): preserve diagnostics and recovery reasons`.

### Task 7: Exclusive cold start and pricing-source closure

**Files:**
- Modify: `apps/server/src/leasing/quota/fair-share-window.ts`
- Test: `apps/server/src/leasing/quota/fair-share-window.spec.ts`
- Modify: `apps/app/usage_stats.go`
- Test: `apps/app/usage_stats_test.go`
- Verify: `packages/shared/src/quota-rates.json`
- Verify: `packages/shared/src/api-pricing.json`

- [ ] Write a failing test that a sole full-share exclusive subject cold-primes at mother fraction 0.33 and receives personal fraction 0.33, while two-subject/oversold cases remain unattributed.
- [ ] Attribute initial burn only under the sole/full/exclusive predicate.
- [ ] Write a failing Go test showing blank/unknown Codex or Anthropic model IDs use the conservative `api-pricing.json` path instead of legacy family prices.
- [ ] Route every model-aware Codex/Anthropic value through `calculateAPIValue`; retain legacy pricing only for unrepresented providers.
- [ ] Run shared pricing, server quota, and Go usage tests; commit `fix(quota): close cold-start and pricing fallbacks`.

### Task 8: End-to-end isolation and final regression

**Files:**
- Modify: `tests/quota-e2e/run.mjs`
- Modify: `tests/quota-e2e/server-fixture.ts`
- Modify: `apps/app/quota_client_server_e2e_test.go`
- Update: `docs/superpowers/plans/2026-07-12-quota-final-hardening.md`

- [ ] Split destructive clock/restart/fault scenarios into isolated temporary databases and server lifecycles; no scenario may depend on a previous scenario's clock or rows.
- [ ] Add production-boundary scenarios for compact restart, actual subscription-load failure, stale revision rejection, old-server client clearing, long completion, official reset, join/leave/rebind, and diagnostic failure recovery.
- [ ] Run `pnpm test:quota-e2e` three consecutive times and require 3/3 green.
- [ ] Run `pnpm test` and require lint, 1,800+ server tests, frontend, Go, integration, and E2E green.
- [ ] Run `git diff --check`, inspect `git status`, update every checkbox with evidence, and commit `test(quota): complete final hardening regression`.
