# Weekly Fair-Share and Exclusive Quota Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct weekly Codex fair-share attribution and cap the exclusive single bar by account quota, then publish BingchaAI 13.4.1.

**Architecture:** The server distinguishes an overlapping earlier upstream window from a truly stale window and lets the existing delta merge attribute accumulated usage. The frontend keeps the exclusive presentation but caps its single visible value by the known account fraction.

**Tech Stack:** TypeScript, Vitest, React, Go/Wails, GitHub Actions.

---

### Task 1: Reproduce weekly reset drift

**Files:**
- Test: `apps/server/src/leasing/token-server/__tests__/fair-share-tracker.spec.ts`
- Modify: `apps/server/src/leasing/token-server/fair-share-tracker.ts`

- [ ] Add a test that primes a weekly tracker at `02:22:20Z`, records per-card usage, applies `fraction=0.62` with upstream start `01:33:47Z`, and expects realignment plus nonzero attribution.
- [ ] Add a test that a snapshot whose reset ends before the current local window remains ignored.
- [ ] Run the focused tests and confirm the overlap test fails because `lastFraction` remains `1`.
- [ ] Replace the unconditional backward-start return with an overlap check: reject only when `resetAtMs <= tracker.windowStart + RESET_DRIFT_MS`; otherwise assign `tracker.windowStart = newStart` and continue through the normal merge.
- [ ] Re-run focused tests and confirm both pass.

### Task 2: Cap the exclusive single bar

**Files:**
- Test: `apps/app/frontend/src/lib/quotaDisplay.test.ts`
- Test: `apps/app/frontend/src/components/SubscriptionUsageCarousel.test.tsx`
- Modify: `apps/app/frontend/src/lib/quotaDisplay.ts`

- [ ] Change the exclusive pure-function test to require `min(myFraction, accountFraction)` while preserving `exclusive=true` and `accountRemain=-1`.
- [ ] Add component coverage proving the card still renders only `剩余` and not the account layer.
- [ ] Run focused frontend tests and confirm they fail with the old uncapped value.
- [ ] Compute the capped exclusive remainder when account quota is known and use it for both bar width and health color.
- [ ] Re-run focused frontend tests and confirm they pass.

### Task 3: Version and verification

**Files:**
- Modify: `apps/app/updater.go`

- [ ] Set `AppVersion` to `13.4.1`.
- [ ] Run the targeted server and frontend tests.
- [ ] Run server/frontend type checks and the Wails frontend build.
- [ ] Review the diff for unrelated changes.

### Task 4: Publish

- [ ] Commit the verified change to `main`.
- [ ] Push `main` to `origin`.
- [ ] Dispatch `build-wails.yml` for `13.4.1` with a neutral public changelog and forced minimum `13.4.1`.
- [ ] Watch the workflow to completion and verify the public release and generated manifest commit.
