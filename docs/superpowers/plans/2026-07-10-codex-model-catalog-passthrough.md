# Codex Model Catalog Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded Codex `/v1/models` response with official catalog passthrough, in-flight request coalescing, and `models_cache.json` fallback.

**Architecture:** `CodexProxy` fetches the official ChatGPT Codex catalog using the existing leased token and egress stack, validates and returns the raw payload, and coalesces only concurrent identical requests. Codex remains the sole long-lived cache owner; failures read its disk cache and finally return an empty valid catalog.

**Tech Stack:** Go 1.26, `net/http`, existing Codex uTLS/egress helpers, `httptest`.

---

### Task 1: Official catalog passthrough and fallback

**Files:**
- Modify: `apps/app/codex_proxy_test.go`
- Modify: `apps/app/codex_proxy.go`

- [ ] **Step 1: Write failing passthrough tests**

Add focused tests with injected lease and HTTP-client functions:

```go
func TestCodexModelsPassthrough(t *testing.T) {
    // Assert GET /backend-api/codex/models?client_version=0.144.0,
    // leased Authorization and account id, raw models body, and ETag.
}

func TestCodexModelsFallsBackToDiskCache(t *testing.T) {
    // Use t.Setenv("CODEX_HOME", t.TempDir()), write models_cache.json,
    // fail upstream, and assert the disk payload is returned with HTTP 200.
}

func TestCodexModelsFallsBackToEmptyCatalog(t *testing.T) {
    // Fail upstream without a valid cache and assert {"models":[]}.
}
```

- [ ] **Step 2: Run the focused tests and verify red**

```bash
cd apps/app && go test ./... -run 'TestCodexModels' -count=1
```

Expected: FAIL because `/v1/models` still returns the hard-coded OpenAI `data` list.

- [ ] **Step 3: Implement passthrough and disk fallback**

Add a testable HTTP client factory to `CodexProxy`, then replace `sendModels` with:

```go
type codexModelsResult struct {
    body []byte
    etag string
    err  error
}

func (p *CodexProxy) serveModels(w http.ResponseWriter, r *http.Request, card, deviceID, upstreamProxy string) {
    result := p.fetchModelsCoalesced(r, card, deviceID, upstreamProxy)
    if result.err == nil {
        writeCodexModelsResponse(w, result.body, result.etag)
        return
    }
    if body, etag, err := readCodexModelsCache(); err == nil {
        writeCodexModelsResponse(w, body, etag)
        return
    }
    writeCodexModelsResponse(w, []byte(`{"models":[]}`), "")
}
```

The official fetch must target `DefaultCodexEndpoint + "/backend-api/codex/models"`, preserve `RawQuery`, lease with `force=false`, replace authorization with the lease token, set the account id from the JWT, set JSON/identity headers, enforce a four-second context timeout, require 2xx, limit the body size, and validate a top-level `models` array.

- [ ] **Step 4: Run focused tests and verify green**

```bash
cd apps/app && go test ./... -run 'TestCodexModels' -count=1
```

Expected: PASS.

### Task 2: Concurrent request coalescing

**Files:**
- Modify: `apps/app/codex_proxy_test.go`
- Modify: `apps/app/codex_proxy.go`

- [ ] **Step 1: Write the failing concurrency test**

```go
func TestCodexModelsCoalescesConcurrentRequests(t *testing.T) {
    // Block the first upstream call, issue two identical ServeHTTP calls,
    // release it, and assert both responses match while lease/upstream counts are one.
}
```

- [ ] **Step 2: Run the concurrency test and verify red**

```bash
cd apps/app && go test ./... -run TestCodexModelsCoalescesConcurrentRequests -count=1
```

Expected: FAIL with lease/upstream count 2.

- [ ] **Step 3: Add an in-flight-only call map**

```go
type codexModelsCall struct {
    done   chan struct{}
    result codexModelsResult
}

// CodexProxy fields; entries are removed immediately after completion.
modelsMu       sync.Mutex
modelsInFlight map[string]*codexModelsCall
```

Key calls by `card + "\x00" + r.URL.RawQuery`, never log the key, and clone result bytes for waiting callers. This map must not retain completed responses.

- [ ] **Step 4: Run focused tests with the race detector**

```bash
cd apps/app && go test -race ./... -run 'TestCodexModels' -count=1
```

Expected: PASS with no race report.

### Task 3: Regression verification

**Files:**
- Modify: `apps/app/codex_proxy.go`
- Modify: `apps/app/codex_proxy_test.go`

- [ ] **Step 1: Format modified Go files**

```bash
cd apps/app && gofmt -w codex_proxy.go codex_proxy_test.go
```

- [ ] **Step 2: Run Codex-related tests**

```bash
cd apps/app && go test ./... -run 'Codex|codex' -count=1
```

Expected: PASS.

- [ ] **Step 3: Run the complete Go suite**

```bash
cd apps/app && go test ./... -count=1
```

Expected: PASS.

- [ ] **Step 4: Inspect the final diff**

```bash
git diff --check
git diff -- apps/app/codex_proxy.go apps/app/codex_proxy_test.go
```

Expected: no whitespace errors, no hard-coded Codex model list, and no unrelated changes in the implementation diff.
