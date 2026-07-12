# Client 13.5.0 Forced-Upgrade Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish desktop client 13.5.0 and force every older client to upgrade before obtaining a lease.

**Architecture:** Keep the desktop source version, server lease floor, and generated update-manifest floor identical. Use the existing multi-platform GitHub Actions workflow as the only binary publishing path, then verify the public release and workflow-generated manifest from remote state.

**Tech Stack:** Go/Wails, TypeScript/Vitest, GitHub Actions, GitHub CLI.

---

### Task 1: Pin the 13.5.0 client and server floors

**Files:**
- Modify: `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts`
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts`
- Modify: `apps/app/updater_test.go`
- Modify: `apps/app/updater.go`

- [x] **Step 1: Change the server regression to reject 13.4.2 and accept 13.5.0**

Update the existing default-minimum test to call `leaseToken` with `clientVersion: "13.4.2"` in the rejection assertion and `clientVersion: "13.5.0"` in the accepted request.

- [x] **Step 2: Add a client source-version regression**

Add to `apps/app/updater_test.go`:

```go
func TestAppVersionMatchesRelease1350(t *testing.T) {
	if AppVersion != "13.5.0" {
		t.Fatalf("AppVersion = %q, want 13.5.0", AppVersion)
	}
}
```

- [x] **Step 3: Run both focused tests and verify RED**

Run:

```bash
pnpm --filter @gfa/server exec vitest run src/leasing/lease-core/__tests__/lease-service.spec.ts -t "rejects clients below the new default minimum version"
cd apps/app && go test . -run '^TestAppVersionMatchesRelease1350$' -count=1
```

Expected: the server test fails because 13.4.2 is still accepted; the Go test fails because `AppVersion` is still 13.4.2.

- [x] **Step 4: Update both production constants**

Set:

```ts
this.minClientVersion = options.minClientVersion ?? "13.5.0";
```

and:

```go
var AppVersion = "13.5.0"
```

- [x] **Step 5: Run focused tests and the full regression**

Run the two focused commands from Step 3, then run `pnpm test`. Expected: all commands exit 0.

- [ ] **Step 6: Commit and push main**

```bash
git add apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts apps/server/src/leasing/lease-core/lease-service.ts apps/app/updater_test.go apps/app/updater.go docs/superpowers/plans/2026-07-12-client-13-5-0-release.md
git commit -m "release: require client 13.5.0"
git push origin main
```

### Task 2: Build and publish every desktop platform

**Files:**
- Workflow-generated: `apps/web/public/updates/latest-wails.json`

- [ ] **Step 1: Dispatch the canonical workflow**

```bash
gh workflow run build-wails.yml --ref main \
  -f version=13.5.0 \
  -f min_version=13.5.0 \
  -f changelog="额度显示准确性与客户端稳定性优化"
```

- [ ] **Step 2: Identify and watch the exact run**

Use `gh run list --workflow build-wails.yml --branch main --event workflow_dispatch --limit 10 --json databaseId,headSha,status,conclusion,createdAt` and select the newest run whose `headSha` equals the pushed release commit. Run `gh run watch <run-id> --exit-status` and require exit 0.

- [ ] **Step 3: Verify the public release**

Run `gh release view wails-v13.5.0 --repo bingcha-2/bcai-releases --json tagName,name,isLatest,assets,publishedAt`. Require the release to be latest and to contain:

- `BingchaAI-13.5.0.exe`
- `BingchaAI-13.5.0-setup.exe`
- `BingchaAI-13.5.0-arm64.dmg`
- `BingchaAI-13.5.0-amd64.dmg`
- `BingchaAI-13.5.0-linux-amd64.tar.gz`

### Task 3: Synchronize and verify forced-upgrade metadata

**Files:**
- Generated and committed by workflow: `apps/web/public/updates/latest-wails.json`

- [ ] **Step 1: Pull the workflow manifest commit**

Run `git pull --ff-only origin main` after the workflow succeeds.

- [ ] **Step 2: Validate the manifest structurally**

Use Node to assert `version === "13.5.0"`, `minVersion === "13.5.0"`, every Windows/macOS/Linux URL contains `wails-v13.5.0`, every SHA-256 is 64 hexadecimal characters, and every size is positive.

- [ ] **Step 3: Verify public reachability and remote synchronization**

Fetch `https://bcai.lol/updates/latest-wails.json`, require HTTP 200 and the same version/minVersion, verify the five GitHub release asset URLs return a successful response, then confirm local `HEAD` equals `origin/main` and the worktree is clean.

- [ ] **Step 4: Provide the Windows server handoff**

Give the operator the schema-sensitive update commands from the GFA service operations guide: stop services, pull main, back up `prisma/dev.db`, run the appropriate migration path, restart, then verify ports 3000/3001, `/api/health`, and daemon/API/Web/worker logs. Explicitly state that Caddy is not touched for this update.
