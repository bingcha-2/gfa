# Quota Minimal Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four confirmed production defects (startup mass-429, retry double-count, logout stale blood bars, long-stream attribution loss) plus the E2E virtual-clock pollution, with ~150 lines of production code and TDD throughout.

**Architecture:** No new tables, no reducer rework. Each fix is a targeted guard on an existing path: gate membership reconciliation on subscription-load success; carry unpersisted receipt ids in every scheduled flush; call the existing `clearLocalCardState()` on Go auth transitions; extend expired-lease retention from 60s to the existing 35-minute replay grace; isolate the E2E clock-jumping scenario at the end of the matrix.

**Scope explicitly deferred (do NOT implement):** reorder-tail event ledger, revision-conflict rejection, diagnostics write queue, account_recovering, blood-bar identity tuples, sole-exclusive cold-start backfill, backward resetAt.

**Tech Stack:** TypeScript/Vitest (apps/server), Go (apps/app), Node E2E harness (tests/quota-e2e).

---

### Task 1: Startup barrier — subscription load failure must not shrink membership

**Files:**
- Modify: `apps/server/src/leasing/token-server/token-server.service.ts` (`loadActiveSubscriptions`, ~line 155)
- Modify: `apps/server/src/leasing/token-server/access-key-store.ts` (readiness flag)
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts` (`onModuleInit`, ~line 1645)
- Test: `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts`
- Test: `apps/server/src/leasing/subscription/__tests__/entitlement-sync.service.spec.ts` or new focused spec

**Behavior:** `loadActiveSubscriptions` sets `accessKeyStore.markSubscriptionsReady()` only on success; on failure it schedules retry with backoff (5s, 15s, 60s, then every 60s) and leaves the store not-ready. `LeaseService.onModuleInit` skips `refreshAllParticipants()` + `flush()` while the store reports `!subscriptionsReady()` and defers reconciliation to a ready-callback. Lease admission while not-ready returns 503 `server_warming_up` instead of computing fair share from an incomplete member list.

- [ ] **Step 1: Write failing spec** — construct LeaseService with a store whose `subscriptionsReady()` is false; assert `onModuleInit` does NOT emit a membership event (spy on tracker `refreshAllParticipants`) and that `leaseToken` returns 503 with code `server_warming_up`. Second case: readiness flips true → deferred reconciliation runs exactly once.
- [ ] **Step 2: Run focused spec, confirm RED** (missing method / no 503).
- [ ] **Step 3: Implement** readiness flag + retry loop + gate + ready-callback.
- [ ] **Step 4: Run focused server specs GREEN**; run full `pnpm --dir apps/server exec vitest run src/leasing/` GREEN.
- [ ] **Step 5: Commit** `fix(quota): gate membership reconciliation on subscription readiness`

### Task 2: Scheduled flush carries unpersisted receipts

**Files:**
- Modify: `apps/server/src/leasing/token-server/fair-share-tracker.ts` (`checkpointReport` ~line 270, `flush` ~line 963, entry bookkeeping)
- Test: `apps/server/src/leasing/token-server/__tests__/fair-share-tracker.spec.ts`

**Behavior:** Tracker keeps `pendingReceipts: Map<accountBucketKey, { reportIds: Set<string>; accountings: Map<string, HourlyUsageAccounting> }>` populated when usage is applied (recordUsage/checkpointReport path). Every enqueue — including the dirty-tick `flush()` which today sends `reportIds: []` — includes the pending set. Entries clear only after the coordinator commit resolves for a revision ≥ the one that carried them.

- [ ] **Step 1: Write failing spec** — apply a usage report without awaiting `checkpointReport`; trigger `flush()`; assert the repository `checkpointBatch` payload contains the reportId + accounting. Second case: after a successful commit, a later flush does not resend the same reportId.
- [ ] **Step 2: Run focused spec, confirm RED** (payload has empty reportIds).
- [ ] **Step 3: Implement** pending-receipt bookkeeping (populate, attach on both flush paths, clear on commit success, retain on failure).
- [ ] **Step 4: Run tracker + repository + lease-service specs GREEN.**
- [ ] **Step 5: Commit** `fix(quota): persist pending receipts on scheduled flush`

### Task 3: Go client clears blood bars on auth transitions

**Files:**
- Modify: `apps/app/user_auth.go` (`UserLogout` ~line 340, `UserLogin` ~line 300, heartbeat forced-logout ~line 690)
- Test: `apps/app/user_auth_test.go`

**Behavior:** `UserLogout`, the heartbeat forced-logout branch, and `UserLogin` (before starting services for the new session) call `clearLocalCardState()` so `boundFractions` (including both personal maps) never survive an account switch.

- [ ] **Step 1: Write failing Go test** — seed `recordMyPersonalBucketFraction("codex-gpt", 0.9)`, run the logout state-clearing path, assert `snapshotMyPersonalFractions()` is empty; same for the login path.
- [ ] **Step 2: Run `go test -run TestLogout -count=1 .`, confirm RED.**
- [ ] **Step 3: Implement** the three call sites.
- [ ] **Step 4: Run `go test ./... -count=1` GREEN.**
- [ ] **Step 5: Commit** `fix(app): clear quota blood bars on logout and login`

### Task 4: Expired leases retained through the replay grace

**Files:**
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts:217` (`REPORT_GRACE_MS`)
- Test: `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts`

**Behavior:** `cleanupExpiredLeases` retains leases until `expiresAt + REPORT_REPLAY_GRACE_MS` (35 min) instead of +60s, so a 16–45 minute stream still finds its lease and attributes usage. Expired leases must remain unusable for new admission (existing expiry checks unchanged).

- [ ] **Step 1: Write failing spec** — create lease, advance injected clock 20 min past expiry, run cleanup (via `getStatus`), then `reportResult` with fresh `upstreamCompletedAt`; assert usage is attributed to the original card (tracker spy) and response is a normal ack. Counter-case: 40 min past expiry → lease swept, report handled per existing lease-less path.
- [ ] **Step 2: Run focused spec, confirm RED** (lease already swept at 20 min).
- [ ] **Step 3: Implement** — sweep threshold uses `REPORT_REPLAY_GRACE_MS`; delete the now-unused `REPORT_GRACE_MS` or repoint it.
- [ ] **Step 4: Run lease-service + full server specs GREEN.**
- [ ] **Step 5: Commit** `fix(lease): retain expired leases through the 35-minute replay grace`

### Task 5: E2E — clock isolation + four new scenarios

**Files:**
- Modify: `tests/quota-e2e/run.mjs`
- Modify: `apps/server/src/leasing/quota/__tests__/quota-e2e-test-control.controller.ts` (only if a new fault hook is required for Task 1's scenario)

**Behavior:**
1. Move the `exclusive-oversell-official-reset` block (the `t + 7d` clock jump, currently ~line 275) to the END of the matrix so no later scenario runs inside the polluted virtual future; assert `useRealtimeClock()` restores before any remaining assertions.
2. New scenario `flush-carries-receipts`: report usage, arm one-shot checkpoint failure, crash before the receipt persists via retry, restart, resend the same reportId; assert window CU unchanged (no double count) and receipt now durable.
3. New scenario `long-stream-attribution`: lease, advance virtual clock 20 min (past lease TTL + old 60s sweep), trigger a status call (runs cleanup), then report with fresh completion time; assert the usage is attributed to the leasing card in `FairShareWindowHead` state.
4. New scenario `startup-subscriptions-unavailable`: boot the fixture with a one-shot injected subscription `findMany` failure; assert lease requests return 503 `server_warming_up` (not 429), then after the retry succeeds assert members are intact and leasing works.
5. Go side (existing `quota_client_server_e2e_test.go` run): add assertion that after simulated logout state-clear, `GetStats` shows no personal fractions (extends the existing Wails-boundary test).

- [ ] **Step 1: Add the scenarios and clock reordering; run `pnpm test:quota-e2e`, confirm the new scenarios RED against pre-fix behavior only where the fix is not yet merged (if executing after Tasks 1–4, they must be GREEN; verify each scenario actually exercises its fix by temporarily reverting the fix commit locally if in doubt).**
- [ ] **Step 2: Run the full matrix 5 consecutive times: `for i in 1 2 3 4 5; do node tests/quota-e2e/run.mjs || break; done` — 5/5 GREEN.**
- [ ] **Step 3: Commit** `test(quota): isolate e2e clock and cover hardening fixes end to end`

### Task 6: Regression gate

- [ ] Run `pnpm --dir apps/server test` — all pass.
- [ ] Run `cd apps/app && go test ./... -count=1` — all pass.
- [ ] Run `pnpm --dir apps/app/frontend test` — all pass.
- [ ] Run `pnpm test:quota-e2e` ×3 — all pass.
- [ ] Commit any doc updates; do not push without an explicit ask.
