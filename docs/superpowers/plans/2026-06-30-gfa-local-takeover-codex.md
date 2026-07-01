# GFA 本地接管(Codex 端到端,P0+P1)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 GFA 桌面客户端登录自己的 ChatGPT 账号 → 本机起 CLIProxyAPI 网关多号路由 → 接管本地 Codex CLI 指向网关 → 配额监控与切号,全程不经服务端号池。

**Architecture:** 客户端进程内嵌入 CLIProxyAPI SDK 作数据面(已实测可编译);Go 原生写控制面(账号 SQLite store、OAuth、网关生命周期、接管协调),全部进 `apps/app/internal/local/*` 独立子包(不污染平铺的 `package main`);前端进 `features/local/*`。接管的「远程/本地」是同一注入位的号源维度,薄协调层互斥。

**Tech Stack:** Go 1.26(GOTOOLCHAIN=auto 自动拉)、`github.com/router-for-me/CLIProxyAPI/v7`、`modernc.org/sqlite`、`go-toml/v2`、Wails v2.12、React + Zustand + Tailwind。

**设计依据:** [2026-06-30-gfa-local-takeover-design.md](../specs/2026-06-30-gfa-local-takeover-design.md)。安全不变式见 spec §3:**租号绝不进本地网关 auth store**。

---

## 文件结构(包拆分)

```
apps/app/
├── go.mod                      # 改:加 CLIProxyAPI 依赖 + 工具链 1.26
├── app.go                      # 改:加薄 Wails 绑定方法,委托 internal/local
├── takeover.go                 # 改:codexTarget.Inject 接受号源参数(薄协调)
├── internal/
│   └── local/
│       ├── account/            # package account — 本地账号 SQLite store
│       │   ├── account.go      # Account 结构 + 类型
│       │   ├── store.go        # SQLite CRUD + 迁移
│       │   └── store_test.go
│       ├── authsync/           # package authsync — DB→CLIProxyAPI 自有号同步(安全不变式锁点)
│       │   ├── store.go        # 实现 coreauth.Store,只读自有号
│       │   ├── selector.go     # 实现 coreauth.Selector,路由策略
│       │   └── sync_test.go
│       ├── gateway/            # package gateway — 嵌入 CLIProxyAPI Service 生命周期
│       │   ├── gateway.go      # Start/Stop/Status,supervised goroutine
│       │   └── gateway_test.go
│       ├── codexauth/          # package codexauth — Codex OAuth 登录编排
│       │   ├── login.go        # 包装 CodexAuthenticator
│       │   └── login_test.go
│       └── takeover/           # package takeover — 号源协调(本地 vs 远程互斥)
│           ├── source.go       # AccountSource 枚举 + per-product 状态读写
│           └── source_test.go
└── frontend/src/features/local/
    ├── shared/                 # 公共:类型、配额条、provider chip、列表+详情壳、store 工厂
    ├── codex/                  # Codex suite(账号/网关 tab)
    └── (antigravity/ 后续 P3)
```

---

## P0 — 地基

### Task 0.1: 加 CLIProxyAPI 依赖,验证真实 apps/app 共存编译

**Files:**
- Modify: `apps/app/go.mod`

- [ ] **Step 1: 在 apps/app 加依赖**

Run:
```
go -C apps/app get github.com/router-for-me/CLIProxyAPI/v7@latest
```
（若上游版本与 cockpit 副本差异大,改用 `replace` 指向 GFA rensumo fork;见 spec §5。）

- [ ] **Step 2: 全量编译,验证与 wails 等既有依赖共存**

Run: `go -C apps/app build ./...`
Expected: 退出 0。go.mod 出现 `go 1.26.0`(或 `toolchain go1.26.x`)。若出现 MVS 冲突(如 golang.org/x/* 版本),记录冲突包并在 go.mod 用最小提升解决,直到编译通过。

- [ ] **Step 3: 跑一次既有测试确保未回归**

Run: `go -C apps/app test ./... 2>&1 | tail -20`
Expected: 既有测试仍通过(新增依赖不破坏现有)。

- [ ] **Step 4: 提交**

```
git add apps/app/go.mod apps/app/go.sum && git commit -m "feat(local): 引入 CLIProxyAPI 依赖并验证 apps/app 共存编译"
```

### Task 0.2: 本地账号 SQLite store

**Files:**
- Create: `apps/app/internal/local/account/account.go`
- Create: `apps/app/internal/local/account/store.go`
- Test: `apps/app/internal/local/account/store_test.go`

数据模型(对齐 cockpit `CodexAccount` 关键字段 + rosetta `quotaStatus` 模式):

```go
// account.go
package account

type Provider string

const ProviderCodex Provider = "codex"

type AuthKind string

const (
	AuthOAuth  AuthKind = "oauth"
	AuthAPIKey AuthKind = "apikey"
)

type QuotaStatus string

const (
	QuotaOK        QuotaStatus = "ok"
	QuotaError     QuotaStatus = "error"
	QuotaCooling   QuotaStatus = "cooling"
	QuotaExhausted QuotaStatus = "exhausted"
)

type Account struct {
	ID            string      // uuid
	Provider      Provider    // "codex"
	Email         string
	AuthKind      AuthKind    // oauth | apikey
	IDToken       string      // oauth
	AccessToken   string
	RefreshToken  string
	APIKey        string      // apikey 自备号
	APIBaseURL    string      // apikey 自备号
	AccountID     string      // upstream account id
	PlanType      string      // pro/plus/team/free
	Tags          []string
	Note          string
	PoolEnabled   bool        // 是否进网关池
	Priority      bool        // 优先出口
	QuotaStatus   QuotaStatus
	QuotaReason   string
	HourlyPercent int         // 0-100
	WeeklyPercent int
	HourlyResetAt int64        // unix ms
	WeeklyResetAt int64
	BlockedUntil  int64        // unix ms 冷却
	CreatedAt     int64
	LastUsedAt    int64
	UpdatedAt     int64
}
```

- [ ] **Step 1: 写失败测试**

```go
// store_test.go
package account

import (
	"path/filepath"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := OpenStore(filepath.Join(dir, "accounts.db"))
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestStore_AddListGetDelete(t *testing.T) {
	s := newTestStore(t)
	a := &Account{Provider: ProviderCodex, Email: "x@y.com", AuthKind: AuthOAuth, RefreshToken: "rt", PoolEnabled: true}
	if err := s.Add(a); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if a.ID == "" {
		t.Fatal("expected generated ID")
	}
	got, err := s.Get(a.ID)
	if err != nil || got.Email != "x@y.com" {
		t.Fatalf("Get mismatch: %+v %v", got, err)
	}
	list, _ := s.List(ProviderCodex)
	if len(list) != 1 {
		t.Fatalf("List len=%d", len(list))
	}
	if err := s.Delete(a.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	list, _ = s.List(ProviderCodex)
	if len(list) != 0 {
		t.Fatalf("after delete len=%d", len(list))
	}
}

func TestStore_PoolEnabledFilter(t *testing.T) {
	s := newTestStore(t)
	_ = s.Add(&Account{Provider: ProviderCodex, Email: "in@y.com", PoolEnabled: true, RefreshToken: "a"})
	_ = s.Add(&Account{Provider: ProviderCodex, Email: "out@y.com", PoolEnabled: false, RefreshToken: "b"})
	pool, _ := s.ListPoolEnabled(ProviderCodex)
	if len(pool) != 1 || pool[0].Email != "in@y.com" {
		t.Fatalf("pool filter wrong: %+v", pool)
	}
}
```

- [ ] **Step 2: 运行,确认失败**

Run: `go -C apps/app test ./internal/local/account/ -run TestStore -v`
Expected: FAIL（`OpenStore` 未定义）。

- [ ] **Step 3: 实现 store.go**

```go
// store.go
package account

import (
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

const schema = `
CREATE TABLE IF NOT EXISTS local_accounts (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, email TEXT, auth_kind TEXT,
  id_token TEXT, access_token TEXT, refresh_token TEXT, api_key TEXT, api_base_url TEXT,
  account_id TEXT, plan_type TEXT, tags TEXT, note TEXT,
  pool_enabled INTEGER, priority INTEGER, quota_status TEXT, quota_reason TEXT,
  hourly_percent INTEGER, weekly_percent INTEGER, hourly_reset_at INTEGER, weekly_reset_at INTEGER,
  blocked_until INTEGER, created_at INTEGER, last_used_at INTEGER, updated_at INTEGER
);`

func (s *Store) Add(a *Account) error {
	if a.ID == "" {
		a.ID = uuid.NewString()
	}
	now := time.Now().UnixMilli()
	if a.CreatedAt == 0 {
		a.CreatedAt = now
	}
	a.UpdatedAt = now
	tags, _ := json.Marshal(a.Tags)
	_, err := s.db.Exec(`INSERT INTO local_accounts
	  (id,provider,email,auth_kind,id_token,access_token,refresh_token,api_key,api_base_url,
	   account_id,plan_type,tags,note,pool_enabled,priority,quota_status,quota_reason,
	   hourly_percent,weekly_percent,hourly_reset_at,weekly_reset_at,blocked_until,created_at,last_used_at,updated_at)
	  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		a.ID, a.Provider, a.Email, a.AuthKind, a.IDToken, a.AccessToken, a.RefreshToken, a.APIKey, a.APIBaseURL,
		a.AccountID, a.PlanType, string(tags), a.Note, b2i(a.PoolEnabled), b2i(a.Priority), a.QuotaStatus, a.QuotaReason,
		a.HourlyPercent, a.WeeklyPercent, a.HourlyResetAt, a.WeeklyResetAt, a.BlockedUntil, a.CreatedAt, a.LastUsedAt, a.UpdatedAt)
	return err
}

func b2i(b bool) int { if b { return 1 }; return 0 }

func (s *Store) Get(id string) (*Account, error) {
	rows, err := s.db.Query(`SELECT * FROM local_accounts WHERE id=?`, id)
	if err != nil { return nil, err }
	defer rows.Close()
	list, err := scan(rows)
	if err != nil { return nil, err }
	if len(list) == 0 { return nil, sql.ErrNoRows }
	return list[0], nil
}

func (s *Store) List(p Provider) ([]*Account, error) {
	rows, err := s.db.Query(`SELECT * FROM local_accounts WHERE provider=? ORDER BY created_at`, p)
	if err != nil { return nil, err }
	defer rows.Close()
	return scan(rows)
}

func (s *Store) ListPoolEnabled(p Provider) ([]*Account, error) {
	rows, err := s.db.Query(`SELECT * FROM local_accounts WHERE provider=? AND pool_enabled=1 ORDER BY created_at`, p)
	if err != nil { return nil, err }
	defer rows.Close()
	return scan(rows)
}

func (s *Store) Delete(id string) error {
	_, err := s.db.Exec(`DELETE FROM local_accounts WHERE id=?`, id)
	return err
}

func (s *Store) Update(a *Account) error {
	a.UpdatedAt = time.Now().UnixMilli()
	tags, _ := json.Marshal(a.Tags)
	_, err := s.db.Exec(`UPDATE local_accounts SET email=?,auth_kind=?,id_token=?,access_token=?,refresh_token=?,
	  api_key=?,api_base_url=?,account_id=?,plan_type=?,tags=?,note=?,pool_enabled=?,priority=?,quota_status=?,
	  quota_reason=?,hourly_percent=?,weekly_percent=?,hourly_reset_at=?,weekly_reset_at=?,blocked_until=?,
	  last_used_at=?,updated_at=? WHERE id=?`,
		a.Email, a.AuthKind, a.IDToken, a.AccessToken, a.RefreshToken, a.APIKey, a.APIBaseURL, a.AccountID, a.PlanType,
		string(tags), a.Note, b2i(a.PoolEnabled), b2i(a.Priority), a.QuotaStatus, a.QuotaReason, a.HourlyPercent,
		a.WeeklyPercent, a.HourlyResetAt, a.WeeklyResetAt, a.BlockedUntil, a.LastUsedAt, a.UpdatedAt, a.ID)
	return err
}

func scan(rows *sql.Rows) ([]*Account, error) {
	var out []*Account
	for rows.Next() {
		var a Account
		var tags string
		var pool, prio int
		if err := rows.Scan(&a.ID, &a.Provider, &a.Email, &a.AuthKind, &a.IDToken, &a.AccessToken, &a.RefreshToken,
			&a.APIKey, &a.APIBaseURL, &a.AccountID, &a.PlanType, &tags, &a.Note, &pool, &prio, &a.QuotaStatus,
			&a.QuotaReason, &a.HourlyPercent, &a.WeeklyPercent, &a.HourlyResetAt, &a.WeeklyResetAt, &a.BlockedUntil,
			&a.CreatedAt, &a.LastUsedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		a.PoolEnabled = pool == 1
		a.Priority = prio == 1
		if tags != "" { _ = json.Unmarshal([]byte(tags), &a.Tags) }
		out = append(out, &a)
	}
	return out, rows.Err()
}

var _ = strings.TrimSpace
```

- [ ] **Step 4: 运行,确认通过**

Run: `go -C apps/app test ./internal/local/account/ -run TestStore -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```
git add apps/app/internal/local/account/ && git commit -m "feat(local): 本地账号 SQLite store(account 包)"
```

### Task 0.3: 安全不变式 — 自定义 coreauth.Store + Selector(只放行自有号)

**Files:**
- Create: `apps/app/internal/local/authsync/store.go`
- Create: `apps/app/internal/local/authsync/selector.go`
- Test: `apps/app/internal/local/authsync/sync_test.go`

**关键:** 实现 CLIProxyAPI 的 `coreauth.Store` 接口(v7.2.47 实测:`List(ctx)([]*Auth,error)` / `Save(ctx,*Auth)(string,error)` / `Delete(ctx,id)error` —— **无 `Load`/`SetBaseDir`**),其 `List()` **只从本地 account.Store 读 PoolEnabled 自有号**,转成 `*coreauth.Auth`。网关账号唯一入口是这个 Store → lease 没有进入路径(编译期保证:lease 类型不经过此 store)。

- [ ] **Step 1: 写失败测试 — Load 只产出自有号,且字段映射正确**

```go
// sync_test.go
package authsync

import (
	"context"
	"testing"

	"bcai-wails/internal/local/account"
)

func TestStore_LoadOnlyOwnPoolAccounts(t *testing.T) {
	dir := t.TempDir()
	acc, _ := account.OpenStore(dir + "/a.db")
	defer acc.Close()
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "in@y.com", AuthKind: account.AuthOAuth,
		RefreshToken: "rt", AccessToken: "at", AccountID: "acc1", PlanType: "pro", PoolEnabled: true})
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "out@y.com", RefreshToken: "rt2", PoolEnabled: false})

	st := NewStore(acc, account.ProviderCodex)
	auths, err := st.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(auths) != 1 {
		t.Fatalf("expected 1 pool auth, got %d", len(auths))
	}
	a := auths[0]
	if a.Provider != "codex" || a.Metadata["refresh_token"] != "rt" || a.Attributes["plan_type"] != "pro" {
		t.Fatalf("auth mapping wrong: %+v", a)
	}
}
```

（注:`coreauthAuth` 在 store.go 用类型别名 `coreauth.Auth`;测试里用别名引用避免长导入。)

- [ ] **Step 2: 运行,确认失败**

Run: `go -C apps/app test ./internal/local/authsync/ -run TestStore_LoadOnly -v`
Expected: FAIL（`NewStore` 未定义)。

- [ ] **Step 3: 实现 store.go(实现 coreauth.Store)**

```go
// store.go
package authsync

import (
	"context"
	"time"

	"bcai-wails/internal/local/account"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

type coreauthAuth = coreauth.Auth

// Store 实现 coreauth.Store —— 网关账号的唯一来源。
// 只读本地自有号(PoolEnabled);永不接受 lease。
type Store struct {
	acc      *account.Store
	provider account.Provider
}

func NewStore(acc *account.Store, p account.Provider) *Store { return &Store{acc: acc, provider: p} }

func (s *Store) List(ctx context.Context) ([]*coreauth.Auth, error) {
	list, err := s.acc.ListPoolEnabled(s.provider)
	if err != nil {
		return nil, err
	}
	out := make([]*coreauth.Auth, 0, len(list))
	for _, a := range list {
		out = append(out, toAuth(a))
	}
	return out, nil
}

func toAuth(a *account.Account) *coreauth.Auth {
	return &coreauth.Auth{
		ID:       a.ID,
		Provider: string(a.Provider),
		Label:    a.Email,
		Status:   coreauth.StatusActive,
		Attributes: map[string]string{
			"plan_type": a.PlanType,
			"auth_kind": string(a.AuthKind),
		},
		Metadata: map[string]any{
			"access_token":  a.AccessToken,
			"refresh_token": a.RefreshToken,
			"id_token":      a.IDToken,
			"account_id":    a.AccountID,
			"email":         a.Email,
		},
		CreatedAt: time.UnixMilli(a.CreatedAt),
		UpdatedAt: time.UnixMilli(a.UpdatedAt),
	}
}

// Save/Delete 满足接口;不持久化(单一事实源在 account.Store)。
func (s *Store) Save(ctx context.Context, a *coreauth.Auth) (string, error) { return a.ID, nil }
func (s *Store) Delete(ctx context.Context, id string) error                { return nil }
```

- [ ] **Step 4: 运行,确认通过**

Run: `go -C apps/app test ./internal/local/authsync/ -run TestStore_LoadOnly -v`
Expected: PASS。
（注:若 `coreauth.Store` 接口签名与此不符,以真实 SDK 为准微调——Task 执行时先 `go doc github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth.Store` 核对。）

- [ ] **Step 5: 实现 selector.go(路由策略:优先出口 > 配额高者)**

```go
// selector.go
package authsync

import (
	"context"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

type Selector struct{}

func (Selector) Pick(ctx context.Context, provider, model string, opts cliproxyexecutor.Options, auths []*coreauth.Auth) (*coreauth.Auth, error) {
	if len(auths) == 0 {
		return nil, coreauth.ErrNoAvailable
	}
	// 优先 priority=true 的;否则第一个可用(配额排序在 P2 接入 usage 数据后细化)。
	for _, a := range auths {
		if a.Attributes["priority"] == "1" && a.Status == coreauth.StatusActive {
			return a, nil
		}
	}
	return auths[0], nil
}
```
（`cliproxyexecutor.Options` 与 `ErrNoAvailable` 以真实 SDK 为准;执行时 `go doc` 核对 Selector 接口。）

- [ ] **Step 6: 提交**

```
git add apps/app/internal/local/authsync/ && git commit -m "feat(local): 网关 auth Store+Selector,只放行自有号(安全不变式)"
```

### Task 0.4: 网关生命周期(嵌入 CLIProxyAPI Service)

**Files:**
- Create: `apps/app/internal/local/gateway/gateway.go`
- Test: `apps/app/internal/local/gateway/gateway_test.go`

- [ ] **Step 1: 写失败测试 — Start 后端口可连,Stop 后释放**

```go
// gateway_test.go
package gateway

import (
	"net"
	"testing"
	"time"

	"bcai-wails/internal/local/account"
)

func TestGateway_StartStop(t *testing.T) {
	dir := t.TempDir()
	acc, _ := account.OpenStore(dir + "/a.db")
	defer acc.Close()
	g := New(acc, account.ProviderCodex, dir)
	port, err := g.Start(0) // 0 = 自动选端口
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	var ok bool
	for time.Now().Before(deadline) {
		if c, e := net.DialTimeout("tcp", g.Addr(), 200*time.Millisecond); e == nil {
			c.Close(); ok = true; break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !ok {
		t.Fatalf("gateway not listening on %s", g.Addr())
	}
	if err := g.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	_ = port
}
```

- [ ] **Step 2: 运行,确认失败**

Run: `go -C apps/app test ./internal/local/gateway/ -run TestGateway_StartStop -v`
Expected: FAIL（`New` 未定义)。

- [ ] **Step 3: 实现 gateway.go(supervised goroutine + recover)**

```go
// gateway.go
package gateway

import (
	"context"
	"fmt"
	"sync"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/authsync"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

type Gateway struct {
	acc      *account.Store
	provider account.Provider
	dataDir  string

	mu     sync.Mutex
	svc    *cliproxy.Service
	cancel context.CancelFunc
	host   string
	port   int
}

func New(acc *account.Store, p account.Provider, dataDir string) *Gateway {
	return &Gateway{acc: acc, provider: p, dataDir: dataDir, host: "127.0.0.1"}
}

func (g *Gateway) Addr() string { return fmt.Sprintf("%s:%d", g.host, g.port) }

func (g *Gateway) Start(port int) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.svc != nil {
		return g.port, nil
	}
	if port == 0 {
		p, err := freePort()
		if err != nil {
			return 0, err
		}
		port = p
	}
	g.port = port

	cfg := &config.Config{}
	cfg.Host = g.host
	cfg.Port = port
	cfg.AuthDir = g.dataDir // 自有号通过自定义 Store 注入,不依赖目录;保留以满足配置

	mgr := coreauth.NewManager(authsync.NewStore(g.acc, g.provider), authsync.Selector{}, nil)
	svc, err := cliproxy.NewBuilder().WithConfig(cfg).WithCoreAuthManager(mgr).Build()
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	g.svc = svc
	g.cancel = cancel
	go func() {
		defer func() { _ = recover() }() // 兜崩溃,不带垮主程序
		_ = svc.Run(ctx)
	}()
	return port, nil
}

func (g *Gateway) Stop() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.svc == nil {
		return nil
	}
	g.cancel()
	err := g.svc.Shutdown(context.Background())
	g.svc = nil
	return err
}

func (g *Gateway) Running() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.svc != nil
}
```

加 `freeport.go` 辅助(或并入 gateway.go):
```go
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `go -C apps/app test ./internal/local/gateway/ -run TestGateway_StartStop -v`
Expected: PASS。（若 `NewManager`/`WithCoreAuthManager` 签名不符,执行时 `go doc` 核对微调。）

- [ ] **Step 5: 提交**

```
git add apps/app/internal/local/gateway/ && git commit -m "feat(local): CLIProxyAPI 网关进程内生命周期(gateway 包)"
```

### Task 0.5: 接管号源协调(本地/远程互斥)

**Files:**
- Create: `apps/app/internal/local/takeover/source.go`
- Test: `apps/app/internal/local/takeover/source_test.go`
- Modify: `apps/app/codex_inject.go`(`InjectCodexSettings` 已接受 port;此处只加一层选择 port 来源的封装,不改其签名)

设计:per-product `AccountSource`(`remote|local`)持久化进现有 config.json(加字段)。接管时:
- `local` → port = 网关端口;`remote` → port = 现有租号 proxyPort。
- 切换 source 前若已注入,先 `RestoreCodexSettings()` 再以新 port 注入。

- [ ] **Step 1: 写失败测试 — 选择正确端口来源**

```go
// source_test.go
package takeover

import "testing"

func TestResolvePort(t *testing.T) {
	if got := ResolvePort(SourceRemote, 8788, 19528); got != 8788 {
		t.Fatalf("remote want 8788 got %d", got)
	}
	if got := ResolvePort(SourceLocal, 8788, 19528); got != 19528 {
		t.Fatalf("local want 19528 got %d", got)
	}
}
```

- [ ] **Step 2: 运行,确认失败** — Run: `go -C apps/app test ./internal/local/takeover/ -v`,Expected: FAIL。

- [ ] **Step 3: 实现 source.go**

```go
// source.go
package takeover

type AccountSource string

const (
	SourceRemote AccountSource = "remote"
	SourceLocal  AccountSource = "local"
)

// ResolvePort 决定接管注入指向哪个本地端口。
func ResolvePort(src AccountSource, remoteProxyPort, localGatewayPort int) int {
	if src == SourceLocal {
		return localGatewayPort
	}
	return remoteProxyPort
}
```

- [ ] **Step 4: 运行,确认通过** — Run: `go -C apps/app test ./internal/local/takeover/ -v`,Expected: PASS。

- [ ] **Step 5: 提交**

```
git add apps/app/internal/local/takeover/ && git commit -m "feat(local): 接管号源协调(本地/远程端口选择)"
```

---

## P1 — Codex 本地 MVP

### Task 1.1: Codex OAuth 登录编排

**Files:**
- Create: `apps/app/internal/local/codexauth/login.go`
- Test: `apps/app/internal/local/codexauth/login_test.go`

复用 CLIProxyAPI `internal/auth/codex` 的 OAuth(ClientID `app_EMoamEEZ73f0CkXaXp7hrann`,回调端口 1455)。封装为:`StartLogin() (loginURL string, wait func(ctx) (*account.Account, error))`。

- [ ] **Step 1: 写测试 — URL 构造与 PKCE 存在**(纯函数部分先 TDD;真实 OAuth 走端到端手验)

```go
// login_test.go
package codexauth

import "testing"

func TestBuildAuthURL(t *testing.T) {
	u, verifier, err := buildAuthURL("http://localhost:1455/auth/callback")
	if err != nil { t.Fatal(err) }
	if verifier == "" { t.Fatal("expected PKCE verifier") }
	if !contains(u, "client_id=app_EMoamEEZ73f0CkXaXp7hrann") || !contains(u, "code_challenge=") {
		t.Fatalf("auth url missing params: %s", u)
	}
}
func contains(s, sub string) bool { return len(s) >= len(sub) && (indexOf(s, sub) >= 0) }
func indexOf(s, sub string) int { for i := 0; i+len(sub) <= len(s); i++ { if s[i:i+len(sub)] == sub { return i } }; return -1 }
```

- [ ] **Step 2: 运行确认失败** — Run: `go -C apps/app test ./internal/local/codexauth/ -v`,Expected: FAIL。

- [ ] **Step 3: 实现 login.go** — 复用 SDK 的 codex OAuth 常量与 PKCE/token 交换;登录成功后把返回的 token 写入 `account.Store`(AuthKind=oauth,PoolEnabled=true)。执行时优先调用 SDK 的 `CodexAuthenticator.Login` 并把 `*coreauth.Auth` 映射回 `account.Account`,而非重写 OAuth。`buildAuthURL` 仅在 SDK 不暴露纯函数时自实现(PKCE: S256)。

- [ ] **Step 4: 运行确认通过** — Run: `go -C apps/app test ./internal/local/codexauth/ -v`,Expected: PASS。

- [ ] **Step 5: 提交** — `git commit -m "feat(local): Codex OAuth 登录编排(codexauth 包)"`

### Task 1.2: Wails 绑定 — 本地账号生命周期 + 网关 + 接管

**Files:**
- Modify: `apps/app/app.go`(加方法,委托 internal/local;单例 manager)
- Create: `apps/app/local_bindings.go`(集中本地相关 App 方法,避免 app.go 膨胀)

绑定方法(`*App` 上,Wails 自动暴露):
```go
func (a *App) LocalListAccounts(provider string) ([]LocalAccountView, error)
func (a *App) LocalStartCodexLogin() (LoginSession, error)          // 返回 loginURL+loginId
func (a *App) LocalWaitCodexLogin(loginId string) (LocalAccountView, error)
func (a *App) LocalDeleteAccount(id string) error
func (a *App) LocalSetPoolEnabled(id string, enabled bool) error
func (a *App) LocalSetPriority(id string) error
func (a *App) LocalRefreshQuota(id string) (LocalAccountView, error)
func (a *App) LocalGatewayStatus(provider string) GatewayStatus      // running, addr, online count
func (a *App) LocalSetSource(product string, source string) error    // remote|local,触发重注入
```
- [ ] Step 1-5(TDD):为可纯测的映射/状态机写单测(如 `LocalAccountView` 转换、`LocalSetSource` 的互斥重注入逻辑用 fake 注入器),实现,验证,提交。绑定方法本身集成性强,核心逻辑下沉到包内单测,App 方法保持薄。
- [ ] 注:`LocalSetSource(local)` 调用链:确保网关已 Start → `RestoreCodexSettings()`(若远程已注入)→ `InjectCodexSettings(gatewayPort)` → 更新 config 中该 product 的 source。`remote` 反之。

### Task 1.3: 前端 — features/local 脚手架 + Codex suite 账号 tab

**Files:**
- Create: `apps/app/frontend/src/features/local/shared/{types.ts,QuotaBar.tsx,accountStore.ts}`
- Create: `apps/app/frontend/src/features/local/codex/CodexSuitePage.tsx`(账号 tab 主从)
- Modify: `apps/app/frontend/src/types/index.ts`(PageId 加 `'local_codex'`)
- Modify: `apps/app/frontend/src/components/layout/Sidebar.tsx`(分组导航:远程托管 / 本地自有号)
- Modify: `apps/app/frontend/src/services/wails.ts`(包 Local* 绑定)
- Modify: `apps/app/frontend/src/App.tsx`(路由 local_codex → CodexSuitePage)

- [ ] 按 spec §8/§9 实现账号 tab(搜索/筛选/列表+行内展开详情);样式用 GFA token(琥珀单色、近白/深靛、Inter+JetBrains)。组件测试:列表筛选、配额条渲染(`@testing-library/react`,参照现有 `*.test.tsx`)。
- [ ] 侧栏分组、PageId、路由注册;`登录新账号` 调 `LocalStartCodexLogin`→`openURL(loginURL)`→轮询 `LocalWaitCodexLogin`。

### Task 1.4: 接管页号源切换(远程/本地)

**Files:**
- Modify: `apps/app/frontend/src/components/TokenSourceControl.tsx`(每产品加 `远程/本地` 段控,调 `LocalSetSource`;本地模式显示「出口=本地网关 · N 号在线 · 管理账号 →」)
- [ ] Codex/Antigravity 显示两态,Claude 仅远程(本地灰);切换弹确认(重注入会动 config.toml)。

### Task 1.5: 端到端验证(自造数据 + 真实链路)

- [ ] **构建验证**:`go -C apps/app build ./...` 0 退出;`go -C apps/app test ./internal/local/...` 全绿。
- [ ] **前端**:`pnpm -C apps/app/frontend build` 通过;组件测试通过。
- [ ] **网关冒烟(造数据)**:测试用 Store 注入一个**假 codex auth**(refresh/access token 占位),Start 网关,`curl http://127.0.0.1:<port>/v1/models` 断言返回非 401 的结构(走自有号路由);断言**注入 lease 形态的数据无法进入网关**(单测:authsync.Store.Load 永远只回 PoolEnabled 自有号)。
- [ ] **真实链路(手验,需真号)**:登录真实 ChatGPT 号 → 接管页切 Codex 为本地 → Codex CLI 一次请求 → 网关日志出现该请求 → 配额 tab 刷新。记录结果到计划末尾「验证记录」。

---

## 自检(Self-Review)

- **Spec 覆盖**:§5 嵌入→Task 0.1/0.4;§3 安全不变式→Task 0.3(+1.5 断言);§6 控制面→0.2/1.1/1.2;§7 接管协调→0.5/1.2/1.4;§8 IA→1.3/1.4;§9 样式→1.3;§12 TDD→各 Task。P0 全覆盖,P1 覆盖 MVP;Wakeup/多实例/统计/导入导出属 P2,不在本计划(spec §11 已分阶段)。
- **类型一致**:`account.Account`/`account.Store`/`account.Provider` 跨 Task 一致;`authsync.NewStore`、`gateway.New`、`takeover.ResolvePort` 签名前后一致。
- **占位**:SDK 接口签名(`coreauth.Store`/`Selector`/`NewManager`/`CodexAuthenticator`)以 spec §5 实测为基线,执行每 Task 前 `go doc` 核对真实签名再微调——这是已知的、有界的执行期校准,非占位。
- **风险**:Task 0.1 真实 go.mod 共存是首要验收门;不过则按 spec §5 退化 sidecar(同 Builder API,改动小)。
