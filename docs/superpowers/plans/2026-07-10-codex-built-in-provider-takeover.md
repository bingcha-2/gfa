# Codex Built-in Provider Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Codex through BingchaAI while retaining the built-in `openai` provider so remote model discovery remains enabled.

**Architecture:** Inject `openai_base_url` and explicit `model_provider = "openai"`, back up both overwritten values, and remove the legacy custom provider table. Reject local WebSocket upgrades with HTTP 426 so Codex immediately uses its tested HTTP fallback and reaches the existing Responses proxy.

**Tech Stack:** Go, Wails, TOML line editor, `net/http`, Go tests

---

### Task 1: Configuration round-trip

**Files:**
- Modify: `apps/app/codex_config_test.go`
- Modify: `apps/app/codex_inject.go`

- [ ] Write tests asserting injection writes `model_provider = "openai"` plus local `openai_base_url`, removes the legacy provider table, and restores prior values.
- [ ] Run `go test . -run 'TestInjectRestore' -count=1` from `apps/app` and confirm the new assertions fail.
- [ ] Extend the backup payload and injection/restore logic with `prevOpenAIBaseURL`.
- [ ] Run the focused tests and confirm they pass.

### Task 2: WebSocket HTTP fallback

**Files:**
- Modify: `apps/app/codex_proxy_test.go`
- Modify: `apps/app/codex_proxy.go`

- [ ] Add a test sending a WebSocket Upgrade to `/v1/responses` and expecting HTTP 426 without leasing a token.
- [ ] Run the focused test and confirm it fails against the current WebSocket bridge.
- [ ] Add the narrow `/v1/responses` Upgrade rejection before the generic WebSocket bridge.
- [ ] Run the focused proxy test and confirm it passes.

### Task 3: Provider history and restart

**Files:**
- Modify: `apps/app/takeover.go`
- Modify: `apps/app/codex_inject.go`

- [ ] Update takeover comments and restart target to `openai` for both injection and restore.
- [ ] Keep one-time history alignment to migrate legacy `bingchaai` sessions.
- [ ] Run Codex config, proxy, history, and path tests.

### Task 4: Verification and commit

**Files:**
- Verify: `apps/app/...`

- [ ] Run `gofmt` on changed Go files.
- [ ] Run `go test ./... -count=1` from `apps/app`.
- [ ] Inspect `git diff --check` and the scoped diff.
- [ ] Commit only the implementation and related existing user changes requested for main.
