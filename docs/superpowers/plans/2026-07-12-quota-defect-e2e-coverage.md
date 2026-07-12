# Quota Defect End-to-End Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove every hardened quota defect through a real HTTP/client/persistence lifecycle instead of relying only on reducer or repository unit tests.

**Architecture:** Extend the existing `tests/quota-e2e` cross-process matrix. Business transitions continue to enter through the production Codex/Anthropic lease and report controllers; test-only HTTP controls may inject a one-shot persistence failure, attempt a stale revision write, or inspect the otherwise non-public fair-share decision. Client-only regressions run through the production Go proxy/queue and real HTTP transports in the same repository gate.

**Tech Stack:** Node.js orchestration, Go client/proxy, NestJS, Prisma, SQLite, Vitest/Go test.

---

### Task 1: Server HTTP and reducer lifecycle matrix

**Files:**
- Modify: `tests/quota-e2e/run.mjs`

- [x] Add cross-process scenarios for invalid `fraction=-1`, missing `resetAt`, backward `resetAt`, dated model IDs, Chinese 429 reason codes, lease-report expiry, and all snapshot/usage arrival permutations within ten minutes.
- [x] Assert both public lease/report payloads and durable `FairShareWindowHead`, `QuotaReportReceipt`, and `CardUsageHourly` rows.
- [x] Run `node tests/quota-e2e/run.mjs` and retain each assertion as a named scenario.

### Task 2: Persistence failure, stale revision, restart membership, and cutover

**Files:**
- Modify: `apps/server/src/leasing/quota/__tests__/quota-e2e-test-control.controller.ts`
- Modify: `tests/quota-e2e/server-fixture.ts`
- Modify: `tests/quota-e2e/run.mjs`

- [x] Add test-only HTTP controls for one-shot checkpoint failure, stale checkpoint attempt, fair-share decision inspection, and fault status.
- [x] Seed legacy segment rows before boot and assert startup cutover keeps public blood bars, imports no fake CU, creates fixed-size heads, and survives restart.
- [x] Change membership while the server is stopped, restart, and assert startup reconciliation is durable before the first request.
- [x] Trigger a scheduled checkpoint failure, assert the process stays healthy, then assert the next scheduled flush persists the same revision.
- [x] Attempt a lower-revision checkpoint with a receipt and assert neither head/card summary nor receipt rolls back or appears.

### Task 3: Go proxy pricing and pending-report delivery

**Files:**
- Modify: `apps/app/quota_client_server_e2e_test.go`
- Modify: `tests/quota-e2e/run.mjs`

- [x] Send an Anthropic response through the production `ClaudeProxy`, preserve the 5m/1h cache split, report to the live Nest process, and assert the local dashboard uses `api-pricing.json` pricing.
- [x] Drive the production pending-report queue through an HTTP transport failure followed by recovery; include an expired predecessor and another card, then assert each eligible report is delivered exactly once and queue order is preserved.
- [x] Run both Go E2E cases from the cross-process orchestrator.

### Task 4: Regression gate and delivery

**Files:**
- Modify only defects found by the matrix.

- [x] Run `node tests/quota-e2e/run.mjs`.
- [x] Run focused server and Go tests for files touched.
- [x] Run `pnpm test` and inspect the full output for failures or skipped core scenarios.
- [x] Review the diff, commit on `codex/quota-window-recompute`, and push that feature branch.
