# Exclusive, Shared, and Oversold Quota Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show only a card's own attributed remaining quota for exclusive subscriptions while preserving shared-card dual bars and strict mother-account conservation.

**Architecture:** The quota reducer exposes both raw personal remaining and conservation-scaled effective remaining. Enforcement keeps using the effective value; lease, report, heartbeat, Go state, and frontend transport the personal value separately for exclusive display. Existing persisted window state is sufficient, so no database migration is required.

**Tech Stack:** TypeScript, Vitest, NestJS, Go, React, Wails, SQLite/Prisma, quota E2E harness.

---

### Task 1: Split personal and effective quota in the reducer

**Files:**
- Modify: `apps/server/src/leasing/quota/fair-share-window.spec.ts`
- Modify: `apps/server/src/leasing/quota/fair-share-window.ts`
- Modify: `apps/server/src/leasing/quota/window-cu-fair-share-engine.ts`
- Modify: `apps/server/src/leasing/token-server/fair-share-tracker.ts`

- [ ] Add failing reducer tests proving `personalFraction` only reflects the subject's `attributedShare`, while `fraction` remains scaled and total `absoluteRemaining` stays at or below the mother fraction.
- [ ] Run `pnpm --dir apps/server exec vitest run src/leasing/quota/fair-share-window.spec.ts` and confirm failure because `personalFraction` is absent.
- [ ] Return `personalFraction = clamp01(raw / subject.share)` from `getSubjectQuota`; preserve `fraction` and `absoluteRemaining` behavior.
- [ ] Propagate the field through primary and weekly card-fraction result types without changing `check()` enforcement.
- [ ] Re-run the focused server tests and confirm green.

### Task 2: Carry personal quota through lease, report, heartbeat, and Go state

**Files:**
- Modify: `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts`
- Modify: `apps/server/src/leasing/app/app-auth/__tests__/app-auth.service.spec.ts`
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts`
- Modify: `apps/server/src/leasing/app/app-auth/app-auth.service.ts`
- Modify: `apps/app/bloodbar_test.go`
- Modify: `apps/app/user_auth_test.go`
- Modify: `apps/app/leaser_status.go`
- Modify: `apps/app/bloodbar.go`
- Modify: `apps/app/config.go`
- Modify: `apps/app/app.go`

- [ ] Add failing server contract tests asserting `personalFraction` appears in `fairShareQuota`, `weeklyFairShareQuota`, and subscription `productQuota`.
- [ ] Add failing Go tests asserting lease/report parsing and heartbeat parsing retain personal 5-hour and weekly values independently from effective values.
- [ ] Run the focused Vitest and Go tests and confirm missing-field failures.
- [ ] Add optional personal-fraction fields to the server payloads and Go structs/state snapshots; clear them with existing card-change resets.
- [ ] Re-run focused server and Go tests and confirm green.

### Task 3: Render exclusive personal quota and preserve shared dual bars

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

- [ ] Add failing tests proving exclusive display uses `personalFraction=0.8` even when effective/account fractions are `0.4`, renders one bar, and never renders account remaining.
- [ ] Add regression tests proving shared subscriptions still use effective fraction plus the account layer in pure-shared and mixed exclusive/shared accounts.
- [ ] Run `pnpm --dir apps/app/frontend test -- src/lib/quotaDisplay.test.ts src/components/NestedShareBar.test.tsx src/components/SubscriptionUsageCarousel.test.tsx` and confirm expected failures.
- [ ] Thread optional personal fractions through frontend types/store and select them only for exclusive bars; remove the exclusive `min(myFraction, accountFraction)` cap.
- [ ] Keep old-server fallback to effective `fraction` and re-run focused frontend tests to green.

### Task 4: Add real end-to-end oversell coverage

**Files:**
- Modify: `tests/quota-e2e/run.mjs`
- Modify: `tests/quota-e2e/server-fixture.ts`
- Modify: `apps/app/quota_client_server_e2e_test.go`

- [ ] Add an E2E scenario with pure shared oversell and assert shared dual-bar payload fields plus conservation.
- [ ] Add scenarios for one exclusive, two oversold exclusives, and mixed exclusive/shared membership; report distinct usage for each card and assert each exclusive personal fraction changes only for its own usage.
- [ ] Assert the effective absolute quota sum never exceeds the mother fraction and exhausted cards are rejected while other allocated cards remain usable.
- [ ] Exercise both 5-hour and weekly windows through lease, report-result, heartbeat, Go parsing, restart recovery, official reset, changed `resetAt`, join, leave, subscription switch, account switch, duplicate, late, and out-of-order reports.
- [ ] Run `pnpm test:quota-e2e -- --case oversell-display` and confirm the new assertions fail before completing fixture/transport support.
- [ ] Complete the minimum fixture and transport changes, rerun the focused E2E case, and confirm green.

### Task 5: Regression and documentation consistency

**Files:**
- Modify: `docs/superpowers/specs/2026-06-15-exclusive-card-display-quota-design.md`
- Modify: `docs/superpowers/specs/2026-07-11-model-aware-fair-share-recompute-design.md`
- Modify: `apps/app/frontend/src/lib/quotaDisplay.ts`
- Modify: `apps/app/frontend/src/components/NestedShareBar.tsx`
- Modify: `apps/server/src/leasing/token-server/fair-share-tracker.ts`

- [ ] Replace stale statements that exclusive display is mother-capped or bypasses conservation with links to the 2026-07-12 design.
- [ ] Run focused server, Go, frontend, and quota E2E suites.
- [ ] Run `pnpm test` and require all lint, unit, integration, E2E, Go, frontend, pricing, migration, and quota tests to pass.
- [ ] Inspect `git diff --check` and `git status --short`; commit only the intended implementation, tests, and documentation.
