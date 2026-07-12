# Exclusive, Shared, and Oversold Quota Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate personal quota display from conserved effective quota so exclusive users see only their own consumption while shared users keep the existing two-layer display and all requests remain bounded by the mother account.

**Architecture:** The quota reducer computes both `personalFraction` and the existing conserved `fraction`. The server transports both values through lease, report-result, and heartbeat; Go preserves both but continues enforcing with `fraction`; React selects `personalFraction` only for exclusive single-layer bars. Existing persistence is sufficient because the new value is derived from `share` and `attributedShare`.

**Tech Stack:** TypeScript, Vitest, NestJS, Go, React Testing Library, pnpm quota E2E harness, SQLite/Prisma.

---

### Task 1: Quota reducer exposes personal and effective fractions

**Files:**
- Modify: `apps/server/src/leasing/quota/fair-share-window.spec.ts`
- Modify: `apps/server/src/leasing/quota/fair-share-window.ts`

- [ ] **Step 1: Write a failing reducer test**

Add a case with two `share=0.5` subjects where A has `attributedShare=0.2`, B has none, and the mother is `0.4`. Assert A `personalFraction=0.6`, B `personalFraction=1`, while `absoluteRemaining(A)+absoluteRemaining(B)<=0.4`.

- [ ] **Step 2: Verify RED**

Run: `pnpm --dir apps/server test -- src/leasing/quota/fair-share-window.spec.ts`

Expected: FAIL because `personalFraction` is absent.

- [ ] **Step 3: Implement the minimal calculation**

Extend `getSubjectQuota()` with:

```ts
const personalFraction = clamp01(raw / subject.share);
return { fraction: clamp01(absoluteRemaining / subject.share), personalFraction, share: subject.share, absoluteRemaining };
```

Inactive or missing subjects return both fractions as zero.

- [ ] **Step 4: Verify GREEN and reducer invariants**

Run: `pnpm --dir apps/server test -- src/leasing/quota/fair-share-window.spec.ts`

Expected: PASS, including existing conservation/property tests.

### Task 2: Transport both values without changing admission

**Files:**
- Modify: `apps/server/src/leasing/token-server/__tests__/fair-share-window-cu.spec.ts`
- Modify: `apps/server/src/leasing/quota/window-cu-fair-share-engine.ts`
- Modify: `apps/server/src/leasing/token-server/fair-share-tracker.ts`
- Modify: `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts`
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts`

- [ ] **Step 1: Write failing engine and lease-contract tests**

Assert `getCardQuotaFractions()` and both lease quota payloads contain:

```ts
{ fraction: 0.4, personalFraction: 0.8, resetAt: expect.any(Number), share: expect.any(Number) }
```

Also assert `checkFairShare()` still uses `fraction`, blocks when effective quota is exhausted, and never uses `personalFraction` for admission.

- [ ] **Step 2: Verify RED**

Run the two targeted Vitest files and confirm failure is the missing field.

- [ ] **Step 3: Propagate the field**

Change the quota DTO to:

```ts
type CardQuotaFraction = {
  fraction: number;
  personalFraction?: number;
  resetAt: number;
  share: number;
};
```

Window-CU returns both values. The legacy algorithm may omit `personalFraction`; admission code remains untouched.

- [ ] **Step 4: Verify GREEN**

Run the targeted engine, tracker, lease, Codex, and Anthropic service tests.

### Task 3: Heartbeat subscription summaries carry personal fractions

**Files:**
- Modify: `apps/server/src/leasing/app/app-auth/app-auth.service.ts`
- Modify: `apps/server/src/leasing/app/app-auth/__tests__/app-auth.service.spec.ts`

- [ ] **Step 1: Write failing heartbeat tests**

For an exclusive subscription, assert `productQuota[product]` includes `myPersonalHourlyFraction` and `myPersonalWeeklyFraction`. For shared subscriptions, assert existing fields remain unchanged.

- [ ] **Step 2: Verify RED**

Run the focused app-auth spec; expect missing personal fields.

- [ ] **Step 3: Extend the summary mapper**

Make `myFairShareForProduct()` select the tightest effective and personal fractions independently and return both values. Add the optional fields to `ProductQuotaWindow`.

- [ ] **Step 4: Verify GREEN**

Run the app-auth tests and server TypeScript build.

### Task 4: Go preserves display fractions while enforcing effective fractions

**Files:**
- Modify: `apps/app/bloodbar_test.go`
- Modify: `apps/app/codex_leaser_test.go`
- Modify: `apps/app/user_auth_test.go`
- Modify: `apps/app/quota_enforcement_test.go`
- Modify: `apps/app/bloodbar.go`
- Modify: `apps/app/leaser_status.go`
- Modify: `apps/app/config.go`
- Modify: `apps/app/user_auth.go`
- Modify: `apps/app/app.go`

- [ ] **Step 1: Write failing Go parsing/state tests**

Feed `fraction=0.4` and `personalFraction=0.8`; assert snapshots expose both values and quota enforcement still blocks/permits using only `fraction`. Assert reset-on-card-change clears both primary and weekly personal maps.

- [ ] **Step 2: Verify RED**

Run: `cd apps/app && go test ./...`

Expected: compile or assertion failure because personal fields/maps do not exist.

- [ ] **Step 3: Add optional personal state**

Add `HasMyPersonal`, `MyPersonalFraction`, weekly equivalents, parser fields, snapshot helpers, and Wails status keys `myPersonalFractions` / `myPersonalWeeklyFractions`. Keep `quota_enforcement.go` on `MyFraction` and `MyWeeklyFraction`.

- [ ] **Step 4: Verify GREEN and race safety**

Run: `cd apps/app && go test ./...`

Expected: PASS.

### Task 5: React renders exclusive personal quota and shared effective quota

**Files:**
- Modify: `apps/app/frontend/src/lib/quotaDisplay.test.ts`
- Modify: `apps/app/frontend/src/components/NestedShareBar.test.tsx`
- Modify: `apps/app/frontend/src/components/SubscriptionUsageCarousel.test.tsx`
- Modify: `apps/app/frontend/src/lib/quotaDisplay.ts`
- Modify: `apps/app/frontend/src/components/NestedShareBar.tsx`
- Modify: `apps/app/frontend/src/components/SubscriptionUsageCarousel.tsx`
- Modify: `apps/app/frontend/src/pages/DashboardPage.tsx`
- Modify: `apps/app/frontend/src/stores/useAppStore.ts`
- Modify: `apps/app/frontend/src/services/wails.ts`
- Modify: `apps/app/frontend/src/types/index.ts`

- [ ] **Step 1: Write failing display tests**

Assert an exclusive bar with `fraction=0.3`, `personalFraction=0.8`, and `accountFraction=0.05` displays `剩余 80%`, has no account label/layer, and does not cap or multiply by the mother. Assert shared cards still use the two existing values and ignore `personalFraction`.

- [ ] **Step 2: Verify RED**

Run the three focused frontend test files; expect the current exclusive `min()` behavior to fail.

- [ ] **Step 3: Implement display selection**

Add optional `personalFraction` to the bar input. For exclusive cards, use `personalFraction` when known, otherwise fall back to `myFraction`; set `accountRemain=-1`. Do not alter shared-card math.

- [ ] **Step 4: Verify GREEN and frontend build**

Run focused tests, full frontend tests, and `pnpm --dir apps/app/frontend build`.

### Task 6: Real client-server end-to-end coverage

**Files:**
- Modify: `tests/quota-e2e/run.mjs`
- Modify: `apps/app/quota_client_server_e2e_test.go`
- Modify: `tests/quota-e2e/server-fixture.ts`

- [ ] **Step 1: Add failing E2E scenarios**

Extend real HTTP scenarios to cover:

```text
shared only; shared oversell; sole exclusive; two exclusive;
exclusive+shared mixed; primary/weekly reset; resetAt change;
server restart; late/reordered/duplicate report; join/leave/rebind;
mother fall/rebound/zero; Codex/Claude weighted usage.
```

For every exclusive response assert `personalFraction` follows only that card's attributed usage, while effective `fraction × share` sums never exceed the mother. Have the production Go client parse both values and assert its effective enforcement value is distinct from its display snapshot.

- [ ] **Step 2: Verify RED**

Run: `pnpm test:quota-e2e`

Expected: FAIL on missing personal fields or incorrect exclusive cap.

- [ ] **Step 3: Complete only the integration glue exposed by RED**

Fix lease/report/heartbeat fixture wiring and Go helper assertions without adding test-only production behavior.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test:quota-e2e`

Expected: all real server/SQLite/HTTP/Go lifecycle scenarios PASS.

### Task 7: Diagnostics and full regression gate

**Files:**
- Modify: `apps/server/src/leasing/token-server/__tests__/request-log-tracker.spec.ts`
- Modify: `apps/server/src/leasing/token-server/request-log-tracker.ts`

- [ ] **Step 1: Write a failing diagnostic assertion**

Assert a quota trace records account, personal, effective, scale, attributed/unattributed, reset, revision, and event identity without creating a per-request persistence table.

- [ ] **Step 2: Verify RED, implement minimal fields, verify GREEN**

Run the focused diagnostic tests and confirm three-day retention behavior remains covered.

- [ ] **Step 3: Run all regression gates**

Run:

```bash
pnpm --dir apps/server test
pnpm test:frontend
pnpm test:go
pnpm test:integration
pnpm test:quota-e2e
pnpm lint
pnpm build
```

Expected: all commands exit zero with no skipped quota E2E cases.

- [ ] **Step 4: Review the diff against the design**

Confirm no database migration, no changed model rates, no changed oversell sales/binding behavior, and no display value is used for request admission.
