# Anthropic Precharge Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a precharge account pool that fetches Claude organization ids before top-up and activates accounts into the Anthropic OAuth pool after top-up.

**Architecture:** Add a focused `ClaudePrechargeService` backed by `anthropic-precharge-accounts.json`, delegate through `RosettaService`, expose admin endpoints in `RosettaController`, and add a compact management panel to the existing Anthropic accounts page. Reuse the current AdsPower, magic-link, and OAuth helpers.

**Tech Stack:** NestJS service/controller, JSON file storage, Playwright/AdsPower helpers, Next console React page, Vitest.

---

### Task 1: Service Data Model And CRUD

**Files:**
- Create: `apps/server/src/leasing/rosetta/claude-precharge.service.ts`
- Test: `apps/server/src/leasing/rosetta/__tests__/claude-precharge.service.spec.ts`
- Modify: `apps/server/src/leasing/rosetta/rosetta.service.ts`
- Modify: `apps/server/src/leasing/rosetta/rosetta.controller.ts`

- [x] Write failing tests for import, redacted list, delete, and mark-topup.
- [x] Run the service test and confirm it fails because the service does not exist.
- [x] Implement the JSON-backed service methods.
- [x] Wire facade and controller endpoints.
- [x] Run the service test and confirm it passes.

### Task 2: Web Login Probe And Quick Probe

**Files:**
- Modify: `apps/server/src/leasing/rosetta/claude-precharge.service.ts`
- Test: `apps/server/src/leasing/rosetta/__tests__/claude-precharge.service.spec.ts`

- [x] Write failing tests for extracting org metadata from `claude.ai/api/organizations` response and saving sessionKey.
- [x] Implement `loginProbe` and `quickProbe` with injectable helper methods so unit tests do not launch browsers.
- [x] Map successful org fetch to `ORG_READY`; map session failures to `NEEDS_RELOGIN` or `PROBE_FAILED`.
- [x] Run the service test and confirm it passes.

### Task 3: Activation Hooks

**Files:**
- Modify: `apps/server/src/leasing/rosetta/claude-precharge.service.ts`
- Test: `apps/server/src/leasing/rosetta/__tests__/claude-precharge.service.spec.ts`

- [x] Write failing tests showing precharge activation starts password OAuth first and SK fallback starts direct SK OAuth.
- [x] Reuse the existing `startAutoClaudeOAuth` entrypoint without changing existing SK direct behavior.
- [x] Run the affected tests and confirm they pass.

### Task 4: Console UI

**Files:**
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(product)/anthropic-accounts/page.tsx`

- [x] Add typed precharge state and fetch helpers.
- [x] Add import card and precharge table above the formal OAuth pool.
- [x] Add copy org id, login probe, quick probe, mark top-up, activate, SK fallback, and delete actions.
- [x] Keep controls compact and consistent with existing shadcn-style cards, tables, badges, and icon buttons.

### Task 5: Verification

**Files:**
- No new files.

- [x] Run focused server tests.
- [x] Run TypeScript checks for server and web if feasible.
- [x] Review git diff to confirm no unrelated files were changed.
