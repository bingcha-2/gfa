# 本地接管(本地自有号) — 开发说明

把用户**自己 OAuth 登录的账号**(codex / antigravity)在本机起多号网关并接管本地 CLI/IDE,
与既有的「远程托管(租号)」并列。设计/计划见
`docs/superpowers/specs/2026-06-30-gfa-local-takeover-design.md` 与
`docs/superpowers/plans/2026-06-30-gfa-local-takeover-codex.md`。

## 架构

- **数据面**:进程内嵌入 `github.com/router-for-me/CLIProxyAPI/v7`(`sdk/cliproxy`)做多号网关。
  自有号经自定义 `coreauth.Store` 注入(executor 从 `Auth.Metadata["access_token"]` 取 bearer)。
  关键:`Service.Run` 不自动 Load 注入的 manager → 用 `OnAfterStart` hook 在 server 就绪后 `mgr.Load`。
- **控制面**(Go 原生,`apps/app/internal/local/`):
  - `account` — 自有号 SQLite store(单一事实源,provider 列区分)
  - `authsync` — 把 PoolEnabled 自有号桥成网关 auth(`Store.List` + 路由 `Selector`)
  - `gateway` — 嵌入 CLIProxyAPI Service 的起停 + `Reload` + 用量 `Stats`
  - `manager` — 编排(列表/登录/池/优先/删除/导入导出),provider 泛型(`New(acc,gw,provider,loginFn)`)
  - `codexauth` / `antigravityauth` — 各自 OAuth 登录封装(包 SDK Authenticator → `account.Account`)
  - `stats` — 用量收集器(实现 `usage.Plugin`)
  - `takeover` — 号源协调(remote|local 端口选择 + 持久化)
  - `wakeup` — 保活调度(DueAt/RunOnce/历史 + 配置持久化 + 后台循环)
  - `instance` — 多实例 profile CRUD
- **Wails 绑定**:`apps/app/local_bindings*.go`(provider 注册表 + 各 feature 一文件)。
- **前端**:`apps/app/frontend/src/features/local/`,通用 `shared/LocalProviderSuite`(账号/统计/保活/实例 4 tab),
  codex/antigravity 各一行薄壳;`services/localApi.ts` 提供 `ProviderLocalApi`(codexLocalApi / antigravityLocalApi)。

## 安全不变式(务必保持)

**远程租号绝不能进本地网关。** 网关账号唯一入口是 `authsync.Store.List`,只读 PoolEnabled 自有号;
lease 不实现该接口 → 编译期杜绝。两条数据面物理隔离(本地网关 vs `proxy.go` 租号链路)。

## 已完成并自动验证(go test ./... + 前端 vitest 全绿)

账号管理(登录/池/优先/删除/导入导出/批量)、网关嵌入与起停、统计 tab、号源切换(codex)、
Wakeup(调度/配置/历史/后台循环)、多实例(CRUD + 启停 + 改绑)、多 provider 泛化、安全不变式。

## 需真机/真号验证(自动化只到「auth 入池 + /v1 可达」)

- **真实上游 200 出口**:需真 ChatGPT/Google 号;executor 取 `Metadata.access_token` 已核源。
- **Antigravity IDE 本地注入**:号源切换已实现(`LocalSetAntigravitySource` → `InjectIDESettings(网关端口)`,同 codex 模式),但 IDE 经本地网关能否真正出口需真机验证(IDE↔网关协议、可能的 gRPC MITM 细节)。
- **实例启动**:`launchInstance` 用既有 `detectCodexGUIPath`/`detectAntigravityIDEPathCached` + `open -n -a`/exec,需装目标 app;macOS 经 open 拉起的精确停止待用 pgrep 细化。
- **Wakeup 按号精度**:当前为网关级 keep-warm(ping /v1/models);按号 token 刷新待接入。

## 如何加一个 provider

1. `account.ProviderXxx` 常量;2. `xxxauth.Login` 封装 SDK Authenticator;
3. `local_bindings.go` 的 `mk()` 注册 + 加 `local_bindings_xxx.go` 绑定;
4. 前端 `xxxLocalApi` + 一行薄壳 `<LocalProviderSuite title="Xxx" api={xxxLocalApi} />` + 侧栏入口 + 路由。
