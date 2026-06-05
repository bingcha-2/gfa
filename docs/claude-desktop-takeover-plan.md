# Claude Desktop 接管 — 实现方案

> 目标：让 GFA（bcai-wails）在已支持 Claude Code / Codex / Antigravity 接管的基础上，**新增对 Claude Desktop 桌面 App 的接管**，使其对话走自家号池。
>
> 状态：可行性已抓包验证（2026-06-05）。详见结论。

---

## 0. 背景与已验证结论

Claude Desktop 是 Electron/Chromium App，**不认 `ANTHROPIC_BASE_URL`**，所以 GFA 现有「改配置/env」的最小侵入接管法（`takeover.go` 注册表）对它无效。必须新增 **MITM（中间人解密）层**。

抓包实测（mitmproxy + 系统信任根证书）确认：

- **无证书固定（pinning）**：系统信任 mitmproxy 根证书后，Claude Desktop 正常握手、聊天正常回复。
- **对话主体走 `POST api.anthropic.com/v1/messages`（流式 `text/event-stream`）**，与 GFA 现有 `claude_proxy.go` 代理 Claude Code 的端点**完全一致** → 业务逻辑可复用。
- 其它命中端点：`/v1/messages/count_tokens`、`/mcp-registry/v0/servers`、`/api/event_logging/v2/batch`、`a-api.anthropic.com/v1/b`、`s-cdn.anthropic.com/images/*`、`claude.ai/api/organizations/{org}/...`（订阅/登录态）。

**结论**：实现 = 移植 sibling 项目 `reclaude-reverse` 的 Go MITM 层（CA + 叶证书 + CONNECT 拦截）进 bcai-wails + 复用现有 ClaudeProxy。

### 复用 vs 新增

| 模块 | 来源 |
|---|---|
| 租号 / 换 Authorization / 强制出口代理 / SSE 用量解析 / 计费 | ✅ 复用 GFA `apps/bcai-wails/claude_proxy.go` |
| 根 CA 生成 + 叶证书缓存 + CONNECT/TLS 拦截 | 🔁 移植 reclaude `internal/ca` + `internal/proxy`（Go，成本低） |
| 跨平台 CA 安装/卸载 | 🆕 新写（reclaude 只有 Windows PowerShell） |
| Desktop 启动器（带代理重启） | 🔁 参考 reclaude `cmd/launcher`，需跨平台化 |
| 接管入口注册 / UI / 状态检测 | 🔁 接入 GFA `takeover.go` 注册表 + IDE 检测面板 |

---

## 1. 目标架构

```
Claude Desktop (Chromium)
   │  HTTPS_PROXY / 系统PAC → 127.0.0.1:<mitmPort>
   ▼
[bcai-wails 新增 MITM 层]  mitm/proxy.go
   │  CONNECT api.anthropic.com:443
   │  shouldIntercept(*.anthropic.com) → TLS 终止(叶证书, 由本地根CA签)
   ▼  解密出明文 HTTP 请求，按 path 分派：
   ├─ /v1/messages, /v1/messages/count_tokens ─► 复用 ClaudeProxy(租号+换token+出口+计费)
   ├─ auth / telemetry / mcp-registry ─────────► mock 或带池token透传
   └─ claude.ai / a-api / s-cdn / 其它 ────────► 透传(passthrough)
```

- MITM 监听独立端口（如 `127.0.0.1:48801`），与现有明文代理 `48800` 分离。
- 分派到 ClaudeProxy 走**进程内函数调用**，不再多一跳 HTTP。

---

## 2. 任务拆解（可执行）

> 标记：⭐=关键路径　⚠=有风险/未知　🔁=移植　🆕=新写

### Phase 0 — Spike：定型未知项（先做，决定后续设计）

- [ ] **T0.1 ⭐⚠ 抓全 `/v1/messages` 请求头**：确认 `Authorization` 形态、`anthropic-beta`/`anthropic-version` 头、是否携带 claude.ai 登录态衍生的 token。（用本仓库 `docs/` 记录的抓包法：PAC over http + 信任 mitmproxy 根证书）
- [ ] **T0.2 ⭐⚠ 验证「只换 `/v1/messages` 的 Authorization 为号池 OAuth token」能否跑通完整对话**——其余 `claude.ai` 端点用用户真实登录态。决定 MVP 是否需要 mock claude.ai 登录态（让未登录用户也能用），还是要求用户用自己账号登录、仅替换推理 token。
- [ ] **T0.3 输出端点清单**：拦截 / mock / 透传 三类的最终域名+路径表（基于 T0.1 抓包）。
- [ ] **T0.4 确认 macOS 上不误伤 Cowork**：Desktop 接管会重启 App，而 Cowork(Claude Code) 跑在 Desktop 进程树里——明确「接管 Desktop 聊天」与「Cowork 内的 Claude Code（已由现有 env 注入接管）」的边界与共存策略。

**产出**：端点分派表 + 鉴权方案定稿（MVP 范围）。

### Phase 1 — MITM 核心（移植 reclaude）

- [ ] **T1.1 🔁 CA 管理** `apps/bcai-wails/mitm/ca.go`：根 CA 生成+持久化（`~/.bcai/mitm-ca.{crt,key}`，私钥 0600）、`LeafCache` 按 host 动态签叶证书（参考 reclaude `internal/ca/ca.go`）。
- [ ] **T1.2 🔁 MITM 代理** `apps/bcai-wails/mitm/proxy.go`：监听、`handleConnect`、`shouldIntercept(host)`（`*.anthropic.com` 拦、`claude.ai` 透传）、`interceptTLS`（用叶证书做 `tls.Server` 握手）、读 `http.ReadRequest` 后分派（参考 reclaude `internal/proxy/proxy.go`）。
- [ ] **T1.3 🆕 单测**：本地 `curl --proxy 127.0.0.1:48801 https://api.anthropic.com/...` 能拿到本地根 CA 签的证书并被解密；passthrough 域名能正常直连。

### Phase 2 — 跨平台 CA 安装/卸载

- [ ] **T2.1 ⭐ macOS** `mitm/install_darwin.go`：`security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain <ca>`（需 admin，用 osascript `with administrator privileges` 弹原生密码框）；卸载 `security delete-certificate -c <CN>`。
- [ ] **T2.2 Windows** `mitm/install_windows.go`：`certutil -addstore -user Root <ca>`（CurrentUser 免管理员）；卸载 `certutil -delstore`。
- [ ] **T2.3 ⚠ Linux** `mitm/install_linux.go`：系统层 `/usr/local/share/ca-certificates/ + update-ca-certificates`；**外加 NSS db**（Electron/Chromium 在 Linux 用 NSS 而非系统库）：`certutil -d sql:$HOME/.pki/nssdb -A -n bcai -t C,, -i <ca>`。
- [ ] **T2.4 安装状态检测 + 幂等**：`IsCAInstalled()` 各平台实现；重复安装不报错。

### Phase 3 — 请求分派与业务复用

- [ ] **T3.1 ⭐ 重构 ClaudeProxy 为可复用 handler**：把 `claude_proxy.go` 中「租号→`applyClaudeUpstreamHeaders`→`claudeEgressProxy` 出口闸→`copyStreamingClaudeResponse` 计费」核心抽成可被 MITM 内直接调用的函数（不经 HTTP hop），明文代理 `48800` 与 MITM `48801` 共用。
- [ ] **T3.2 ⭐ `/v1/messages` + `count_tokens`**：经 ClaudeProxy 租号、替换 `Authorization`、强制走 `lease.ProxyURL` 出口、解析 SSE 用量上报计费。
- [ ] **T3.3 其它端点**：按 T0.3 清单——`mcp-registry`/`event_logging`/`eval` → mock 或带池 token 透传；`claude.ai`/`a-api.anthropic.com`/`s-cdn.anthropic.com` → 透传。
- [ ] **T3.4 复用 fail-closed 出口闸**：沿用 `claudeEgressBlocked`，无出口代理时拒绝，绝不从本机直连泄露 IP。

### Phase 4 — Desktop 启动器与接管入口

- [ ] **T4.1 🔁 定位 + 启动器** `apps/bcai-wails/claudedesktop_launcher.go`：各平台找 Claude App 路径（mac `/Applications/Claude.app`、Win `%LOCALAPPDATA%`）、杀进程、带代理重启。
  - mac/Win：注入 `HTTPS_PROXY`/`HTTP_PROXY` + `NODE_EXTRA_CA_CERTS`；renderer 用 `--proxy-server=127.0.0.1:48801`。
  - **mac 优选系统 PAC 注入**（只导 `*.anthropic.com`/`claude.ai`，避免误伤其它流量，且可不杀进程；见抓包验证用法），取消接管时 `networksetup -setautoproxystate off`。
- [ ] **T4.2 接入 takeover 注册表**：在 `takeover.go` 的 `takeoverTargets` 加 `claudeDesktopTarget{}`，`InjectionType="mitm"`，实现 `DetectPath/IsInjected/Inject/Restore`。`IsInjected` = CA 已装 && MITM 在跑 && 代理已指向。
- [ ] **T4.3 一键接管 / 取消**：接管=装 CA→起 MITM→设代理/重启 App；取消=撤代理→（可选卸 CA）→重启 App 还原。
- [ ] **T4.4 ⚠ Cowork 共存**：避免接管 Desktop 时打断进程内 Cowork/Claude Code 会话（按 T0.4 结论处理；优先 PAC 注入而非杀进程）。

### Phase 5 — UI / 状态 / 加固

- [ ] **T5.1 检测面板加卡片**：`ide_inject.go` 的 `DetectIDEProducts` 增加 Claude Desktop（已装/已接管/CA 状态/平台支持）。
- [ ] **T5.2 错误处理**：pinning 检测（解密握手失败 → 友好提示「该版本已启用证书固定，暂不支持」）；CA 未装 / 未提权的引导。
- [ ] **T5.3 安全收尾**：卸载/退出时**彻底移除 CA**；私钥权限 0600；MITM 仅拦 anthropic、claude.ai 透传；审计日志。
- [ ] **T5.4 文档 + 风险声明**：用户须知装根 CA 的含义；杀软误报应对。

---

## 3. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| ⚠ Anthropic 给 Desktop 加 **pinning** | 方案当天失效 | 仅能 patch 客户端（asar/二进制），成本高；保留 pinning 检测 + 优雅降级提示 |
| 装根 CA 打破「不碰系统信任」卖点 | 信任成本↑、易被杀软报毒 | 明确告知用户；卸载彻底移除；签名客户端 |
| 跨平台装 CA 体验差（mac 需提权、Linux 需 NSS） | 安装失败率 | 各平台专用实现 + 状态检测 + 引导 |
| ⚠ 鉴权耦合 claude.ai 登录态 | 未登录用户可能用不了 | Phase 0 spike 定论；MVP 可要求用户自有账号登录 |
| 接管重启误伤 Cowork | 打断本地 agent | mac 优先 PAC 注入、不杀进程 |

## 4. 里程碑

1. **M1（spike 完成）**：Phase 0 → 鉴权方案与端点表定稿，确认 MVP 可行。
2. **M2（mac MVP）**：Phase 1+2.1+3+4（mac PAC 路线）→ mac 上 Claude Desktop 聊天走号池跑通。
3. **M3（跨平台）**：Phase 2.2/2.3 + 4 Win/Linux → 三平台可用。
4. **M4（产品化）**：Phase 5 → UI/状态/加固/文档。

## 5. 回滚

- MITM 层完全独立（新端口、新文件），不改现有 `48800` 明文代理路径。
- 接管开关化：取消接管即撤代理 + 卸 CA + 重启 App，回到原生 Desktop。
