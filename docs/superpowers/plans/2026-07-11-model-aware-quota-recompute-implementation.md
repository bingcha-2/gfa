# Model-Aware Quota Recompute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace segment-clearing quota attribution and family-level API valuation with model-aware, restart-safe, causally reordered 5h/weekly accounting, complete diagnostics, and real Go-client-to-Nest-server end-to-end coverage.

**Architecture:** Keep the Nest service as one process and SQLite in its current non-WAL mode. Pure functions calculate model CU and API USD; each account has two independent current-window machines, a bounded reorder tail, and a single in-process write coordinator that micro-batches fixed-size checkpoints. The Go client reports actual model/token/timing data, while compact 72-hour request diagnostics remain separate from authoritative current-window state.

**Tech Stack:** TypeScript, NestJS, Prisma/SQLite, Vitest, Go, Wails client code, React, pnpm, cross-process HTTP E2E.

---

## File map

- `packages/shared/src/quota-rates.json`: versioned model CU registry.
- `packages/shared/src/api-pricing.json`: versioned per-model Standard/Priority and context-tier API prices.
- `packages/shared/src/quota-rates.ts`: typed registry lookup and conservative fallback.
- `packages/shared/src/api-pricing.ts`: typed API-value lookup and single-request calculation.
- `apps/server/src/leasing/quota/fair-share-cu.ts`: provider-neutral CU calculation.
- `apps/server/src/leasing/quota/fair-share-window.ts`: pure current-window reducer, reordering, reset, join/leave, and rebound.
- `apps/server/src/leasing/quota/fair-share-window-repository.ts`: fixed-size current-window load/checkpoint.
- `apps/server/src/leasing/quota/quota-write-coordinator.ts`: single-process 10 ms/64-revision group commit.
- `apps/server/src/leasing/token-server/fair-share-tracker.ts`: compatibility facade over the new reducer/repository.
- `apps/server/src/leasing/lease-core/lease-service.ts`: exactly-once report ingestion and snapshot ordering.
- `apps/app/pricing_price.go`: embedded per-model API pricing.
- `apps/app/usage_stats.go`: exact request USD aggregation and historical quality migration.
- `apps/app/*leaser*.go`: report timestamps, model, usage, trace, and retry protocol.
- `tests/quota-e2e/`: actual Go client helper + actual Nest HTTP server cross-process harness.

### Task 1: Shared quota-rate registry

**Files:**
- Create: `packages/shared/src/quota-rates.json`
- Create: `packages/shared/src/quota-rates.ts`
- Create: `packages/shared/src/quota-rates.spec.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`

- [x] **Step 1: Write failing registry tests**

Cover exact aliases/effective dates for Sol, Terra, Luna, GPT-5.4 mini, Fable, Opus, Sonnet, Haiku; cache/input/output separation; Priority multipliers; and unknown-model conservative fallback with an explicit quality flag.

```ts
expect(calculateQuotaCu(event("gpt-5.6-sol", { input: 1_000_000 }))).toMatchObject({ cu: 5, quality: "exact" });
expect(calculateQuotaCu(event("gpt-5.6-luna", { input: 1_000_000 }))).toMatchObject({ cu: 1, quality: "exact" });
expect(resolveQuotaRate("codex", "unknown-future-model", at).quality).toBe("conservative-fallback");
```

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @gfa/shared exec vitest run src/quota-rates.spec.ts`

Expected: FAIL because `quota-rates.ts` and registry data do not exist.

- [x] **Step 3: Implement the typed registry**

Use canonical ids, aliases, `effectiveFrom/effectiveUntil`, separate input/cache-write/cache-read/output rates, and provider-scoped highest-known fallback. No model-name branching is allowed outside this registry.

- [x] **Step 4: Verify GREEN and commit**

Run: `pnpm --filter @gfa/shared exec vitest run src/quota-rates.spec.ts && pnpm --filter @gfa/shared lint`

Commit: `feat(quota): add versioned model CU registry`

### Task 2: Shared API-equivalent pricing

**Files:**
- Create: `packages/shared/src/api-pricing.json`
- Create: `packages/shared/src/api-pricing.ts`
- Create: `packages/shared/src/api-pricing.spec.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`
- Modify: `scripts/sync-pricing.mjs`

- [x] **Step 1: Write failing pricing tests**

```ts
const value = calculateApiValue({
  provider: "codex", modelId: "gpt-5.6-sol", pricingMode: "standard",
  inputTokens: 593_410, cachedInputTokens: 24_470_000,
  cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 102_560,
  contextTokens: 100_000, occurredAt: Date.parse("2026-07-11T00:00:00Z"),
});
expect(value.usd).toBeCloseTo(18.27885, 8);
expect(value.quality).toBe("exact");
```

Also cover Standard short/long per request, published Priority tiers, explicit unsupported Priority-long quality, Claude 5m/1h cache writes, effective dates, and unknown models.

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @gfa/shared exec vitest run src/api-pricing.spec.ts`

Expected: FAIL because model-aware pricing is absent.

- [x] **Step 3: Implement registry and sync validation**

Make `sync-pricing.mjs` copy both new registries to `apps/app/` and add a `--check` mode that exits non-zero when generated copies differ.

- [x] **Step 4: Verify GREEN and commit**

Run: `pnpm --filter @gfa/shared exec vitest run src/api-pricing.spec.ts && pnpm sync:pricing && node scripts/sync-pricing.mjs --check`

Commit: `feat(pricing): add per-model API equivalent values`

### Task 3: Pure current-window reducer and causal reordering

**Files:**
- Create: `apps/server/src/leasing/quota/fair-share-cu.ts`
- Create: `apps/server/src/leasing/quota/fair-share-cu.spec.ts`
- Create: `apps/server/src/leasing/quota/fair-share-window.ts`
- Create: `apps/server/src/leasing/quota/fair-share-window.spec.ts`

- [x] **Step 1: Write failing CU adapter tests**

Assert all non-zero upstream usage counts, zero usage does not, model multipliers differ, and one event feeds both scopes without double-counting either scope.

- [x] **Step 2: Verify CU RED, implement, verify GREEN**

Run RED/GREEN: `pnpm --filter @gfa/server exec vitest run src/leasing/quota/fair-share-cu.spec.ts`

Implementation must delegate rates to `@gfa/shared`; it must not own a second price table.

- [x] **Step 3: Write failing reducer tests**

Test these event sequences in both arrival orders:

```ts
const reportFirst = reduceAll([usage(A, completedAt(10)), snapshot(20, 1, 0.97)]);
const snapshotFirst = reduceAll([snapshot(20, 1, 0.97), usage(A, completedAt(10), arrivedAt(30))]);
expect(snapshotFirst).toEqual(reportFirst);
```

Add first-request late report, existing A then late B, 1 second/30 second/9m59s lateness, >10m evidence missing, stale snapshot rejection, rebound, independent reset, resetAt drift, join/leave/rebind, and randomized arrival permutations.

- [x] **Step 4: Verify reducer RED**

Run: `pnpm --filter @gfa/server exec vitest run src/leasing/quota/fair-share-window.spec.ts`

Expected: FAIL because the reducer is missing.

- [x] **Step 5: Implement minimal deterministic reducer**

State must contain primary/weekly reset metadata, per-subject cumulative CU/T, assigned/unattributed burn, stable participant metadata, revision, and a reorder tail capped at 10 minutes, 128 segments, and 16 KB serialized. Sorting uses clamped `upstreamCompletedAt`/`observedAt`, never arrival order.

- [x] **Step 6: Verify GREEN and property invariants**

Assert after every generated event:

```text
0 <= fraction <= 1
sum(e_i) <= 1
sum(T_i) + unattributed <= confirmed burn + epsilon
sum(final usable_i) <= mother remaining + epsilon
```

Run: `pnpm --filter @gfa/server exec vitest run src/leasing/quota/fair-share-window.spec.ts`

Commit: `feat(quota): add causal current-window reducer`

### Task 4: Fixed-size Prisma state and micro-batched checkpoints

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260711090000_fair_share_window_head/migration.sql`
- Create: `apps/server/src/leasing/quota/fair-share-window-repository.ts`
- Create: `apps/server/src/leasing/quota/fair-share-window-repository.spec.ts`
- Create: `apps/server/src/leasing/quota/quota-write-coordinator.ts`
- Create: `apps/server/src/leasing/quota/quota-write-coordinator.spec.ts`

- [x] **Step 1: Write failing repository tests against temporary SQLite**

Test intact restart restore, expired-scope reset, corrupt/inconsistent group rejection, fixed row count after 10,000 reports, and current journal mode unchanged.

- [x] **Step 2: Verify repository RED**

Run: `pnpm --filter @gfa/server exec vitest run src/leasing/quota/fair-share-window-repository.spec.ts`

- [x] **Step 3: Add schema/migration and repository**

`FairShareWindowHead` is one row per provider/account/bucket/scope; card rows remain one row per active/current accounting subject. Upsert only the affected account; never provider-wide `deleteMany/createMany`.

- [x] **Step 4: Write failing coordinator tests**

Use a fake transactional repository to prove 1/10/64 requests become one commit, 65 split at the cap, same-account revisions collapse to latest, acknowledgements wait for their persisted revision, failure stays retryable, and prune work yields to checkpoints.

- [x] **Step 5: Verify coordinator RED, implement, verify GREEN**

Run: `pnpm --filter @gfa/server exec vitest run src/leasing/quota/quota-write-coordinator.spec.ts`

Use one in-process queue, a 10 ms timer, maximum 64 account revisions, and no WAL/journal changes.

- [x] **Step 6: Verify migration and commit**

Run: `pnpm db:generate && pnpm --filter @gfa/server lint && pnpm --filter @gfa/server exec vitest run src/leasing/quota/fair-share-window-repository.spec.ts src/leasing/quota/quota-write-coordinator.spec.ts`

Commit: `feat(quota): persist fixed-size window checkpoints`

### Task 5: Tracker facade and product invariants

**Files:**
- Modify: `apps/server/src/leasing/token-server/fair-share-tracker.ts`
- Modify: `apps/server/src/leasing/token-server/__tests__/fair-share-tracker.spec.ts`
- Modify: `apps/server/src/leasing/token-server/__tests__/fair-share-priority.spec.ts`
- Modify: `apps/server/src/leasing/token-server/__tests__/fair-share-exclusive-weekly-coldstart.spec.ts`
- Create: `apps/server/src/leasing/token-server/__tests__/fair-share-window-cu.spec.ts`

- [x] **Step 1: Add failing compatibility and invariant tests**

Prove no `perCard.clear()`, mother rebound raises personal quota, primary/weekly remain independent, oversell uses `D=max(N,sumW)`, pool usable totals never exceed mother, exclusive accounts allow one active subject, and an invalid multi-subject exclusive account falls back to scaling.

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @gfa/server exec vitest run src/leasing/token-server/__tests__/fair-share-window-cu.spec.ts`

- [x] **Step 3: Replace tracker internals behind its public API**

Keep callers stable while delegating record/snapshot/reset/check/recovery to the reducer and repository. Remove 30-second provider-wide replacement as the correctness path; retain only dirty retry fallback.

- [x] **Step 4: Verify focused and legacy tests, commit**

Run: `pnpm --filter @gfa/server exec vitest run src/leasing/token-server/__tests__/fair-share*.spec.ts`

Commit: `refactor(quota): use cumulative current-window accounting`

### Task 6: Exactly-once report/snapshot service integration

**Files:**
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts`
- Modify: `apps/server/src/leasing/token-server/access-key-store.ts`
- Create: `apps/server/src/leasing/lease-core/__tests__/quota-report-ordering.spec.ts`
- Modify: `apps/server/src/leasing/token-server/__tests__/token-server.service.spec.ts`
- Modify: `apps/server/src/leasing/remote-anthropic/__tests__/claude-usage.spec.ts`

- [x] **Step 1: Write failing service tests**

Cover usage-before-attached-snapshot, independent quota-only snapshot before usage, duplicate report before/after restart, stale lease/account mismatch, old snapshot rejection, and atomic report dedup + two-window checkpoint semantics.

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @gfa/server exec vitest run src/leasing/lease-core/__tests__/quota-report-ordering.spec.ts`

- [x] **Step 3: Implement canonical report ingestion**

Parse `traceId/reportId/requestStartedAt/upstreamCompletedAt/observedAt`, clamp bad clocks to lease bounds, calculate CU/API USD once, apply usage before attached snapshot, route independent snapshots through the same account reducer, and await the write coordinator revision before returning success.

- [x] **Step 4: Verify GREEN and commit**

Run: `pnpm --filter @gfa/server exec vitest run src/leasing/lease-core/__tests__/quota-report-ordering.spec.ts src/leasing/token-server/__tests__/token-server.service.spec.ts src/leasing/remote-anthropic/__tests__/claude-usage.spec.ts`

Commit: `feat(quota): make report ingestion causal and durable`

### Task 7: Go client protocol and model-aware valuation

**Files:**
- Modify: `apps/app/pricing_price.go`
- Modify: `apps/app/usage_stats.go`
- Modify: `apps/app/leaser_report.go`
- Modify: `apps/app/codex_leaser.go`
- Modify: `apps/app/claude_leaser.go`
- Modify: `apps/app/codex_proxy.go`
- Modify: `apps/app/codex_ws.go`
- Create: `apps/app/api_pricing_test.go`
- Modify: `apps/app/usage_stats_test.go`
- Create: `apps/app/report_timing_test.go`

- [x] **Step 1: Write failing Go pricing tests**

Assert the Sol golden value `$18.27885`, Luna/Terra/mini differences, Standard short/long, published Priority tiers, unsupported Priority-long quality, Claude cache TTLs, and explicit legacy quality.

- [x] **Step 2: Verify RED**

Run: `cd apps/app && go test ./... -run 'Test(API|UsageStats)'`

- [x] **Step 3: Implement embedded model-aware pricing and migration**

Replace family prices and Fast `x1.5`; store per-request USD/version/mode/context/quality before aggregation. One-time historical migration must be atomic, idempotent, and retain a backup until success.

- [x] **Step 4: Write failing report timing/retry tests**

Assert every report carries stable `traceId/reportId`, actual model, complete token split, `requestStartedAt`, `upstreamCompletedAt`, and snapshot `observedAt`; queued retries preserve original ids/times.

- [x] **Step 5: Implement, verify GREEN, commit**

Run: `cd apps/app && go test ./...`

Commit: `feat(client): report causal usage and exact API values`

### Task 8: Diagnostics and bounded retention

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260711100000_quota_diagnostics/migration.sql`
- Modify: `apps/server/src/leasing/token-server/request-log-tracker.ts`
- Modify: `apps/server/src/leasing/token-server/account-quota-snapshot-tracker.ts`
- Create: `apps/server/src/leasing/token-server/quota-diagnostic-tracker.ts`
- Create: `apps/server/src/leasing/rosetta/quota-diagnostics.service.ts`
- Modify: relevant Nest module/controller files
- Create: focused `*.spec.ts` files beside each service

- [x] **Step 1: Write failing retention and trace tests**

Prove one compact request summary per deduped report, trace/report/lease/account/subject lookup, stable reason codes, 72-hour expiry, row caps, 2 KB headers, 500-row low-priority prune batches, queue overflow counters, and no quota-path failure when diagnostics fail.

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @gfa/server exec vitest run src/leasing/token-server/__tests__/request-log-tracker.spec.ts src/leasing/token-server/__tests__/account-quota-snapshot-tracker.spec.ts src/leasing/token-server/quota-diagnostic-tracker.spec.ts`

- [x] **Step 3: Implement diagnostics and support export**

Include `LATE_USAGE_RECONCILED`, `USAGE_EVIDENCE_MISSING`, snapshot rejection, reset, lifecycle, checkpoint, CU and pricing fields. Do not store credentials or request bodies.

- [x] **Step 4: Verify GREEN and commit**

Run: `pnpm --filter @gfa/server test:unit`

Commit: `feat(quota): add bounded diagnostic trace chain`

### Task 9: Dashboard value and quota presentation

**Files:**
- Modify: `apps/app/frontend/src/pages/DashboardPage.tsx`
- Modify: `apps/app/frontend/src/lib/usageSummary.ts`
- Modify: `apps/app/frontend/src/lib/usageSummary.test.ts`
- Modify: server portal service/tests

- [ ] **Step 1: Write failing UI/portal tests**

Assert “API 等价价值” wording, exact/recalculated/legacy indication, client/server per-model parity, separate 5h/weekly blood bars, and no invented combined minimum pool.

- [ ] **Step 2: Verify RED, implement, verify GREEN**

Run: `pnpm --dir apps/app/frontend test --run && pnpm --filter @gfa/server exec vitest run src/leasing/account/portal`

- [ ] **Step 3: Commit**

Commit: `fix(dashboard): show exact model-aware API values`

### Task 10: Real client-server cross-process E2E

**Files:**
- Create: `tests/quota-e2e/package.json`
- Create: `tests/quota-e2e/run.mjs`
- Create: `tests/quota-e2e/fixtures/`
- Create: `apps/app/cmd/quota-e2e-client/main.go`
- Modify: root `package.json`
- Modify: `apps/server/package.json`

- [ ] **Step 1: Write the failing harness smoke test**

Start a temporary SQLite-backed actual Nest server on an ephemeral port, run the actual Go helper through lease/report/status HTTP, and assert a non-zero request changes both client-visible and server-visible state. No direct tracker mutation is allowed.

- [ ] **Step 2: Verify RED**

Run: `node tests/quota-e2e/run.mjs --case smoke`

Expected: FAIL because the helper/control fixtures are absent.

- [ ] **Step 3: Implement the minimal harness**

The harness may control upstream quota responses and time, but every business transition must use production lease/report/subscription/snapshot endpoints.

- [ ] **Step 4: Add the required matrix test-first**

Add cases for snapshot-before-report, 1s/30s/9m59s late reports, >10m missing evidence, official reset, resetAt drift, rebound, cold start, normal restart, crash/retry, mid-window join/leave/renew/rebind, exclusive fallback, oversell, old snapshot, cross-account snapshot, duplicate report, model changes, pricing parity, and 100-user randomized concurrency.

- [ ] **Step 5: Verify complete E2E and commit**

Run: `node tests/quota-e2e/run.mjs`

Commit: `test(quota): add real client-server lifecycle e2e`

### Task 11: Regression gate, review, and delivery

**Files:**
- Modify only defects found by verification.

- [ ] **Step 1: Run pricing synchronization and schema checks**

Run: `pnpm sync:pricing && node scripts/sync-pricing.mjs --check && pnpm db:generate && pnpm lint`

- [ ] **Step 2: Run focused quota and Go suites**

Run: `pnpm --filter @gfa/server exec vitest run src/leasing/quota src/leasing/token-server/__tests__/fair-share src/leasing/lease-core/__tests__/quota-report-ordering.spec.ts && (cd apps/app && go test ./...)`

- [ ] **Step 3: Run cross-process E2E**

Run: `node tests/quota-e2e/run.mjs`

- [ ] **Step 4: Run the complete repository gate**

Run: `pnpm test`

Expected: lint, all unit tests, integration tests, existing E2E, new quota E2E, and all Go tests pass with zero skipped core quota scenarios.

- [ ] **Step 5: Review implementation against every design acceptance criterion**

Check model CU, API USD, ordering, reset/rebound, lifecycle, persistence, DB bounds, non-WAL behavior, diagnostics, oversell/exclusive, client/server parity, and rollback switches. Record commands and results in the final handoff.

- [ ] **Step 6: Request code review and resolve every finding**

Use the `requesting-code-review` skill, fix findings with a fresh RED/GREEN cycle, then repeat the full relevant verification.

- [ ] **Step 7: Final commit**

Commit: `feat(quota): ship model-aware durable recompute`
