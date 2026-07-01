# 接管前"竞争性中转配置"清理 — 集成方案（评审稿）

> 目标：把一段 Windows PowerShell 清理脚本的**有效内核**，抽成 GFA 接管的一个**跨平台预检步骤**，
> 解决"接管写了配置但没生效"的一类问题。不移植脚本全文，不重复 GFA 已有能力。

## 0. 背景与动机

用户提供了一段 `windows-clean-claude.ps1`，功能是"彻底清理 Claude Code 登录态 + 第三方中转站配置"。
评估后结论：**脚本约 60% 的能力 GFA 已经做得更好，只有约 40% 是 GFA 现在的真空白。**

- **已覆盖（勿重复）**：还原 GFA 自己写入的注入。GFA 每个接管目标 inject 时写 `.bcai-*-backup.json`，
  restore 时逐字段精确回填/删除（`claude_inject.go` / `codex_inject.go` / `mitm_credentials.go` …），
  前端 `TokenSourceControl.tsx` 已有接管/退出开关。这是外科手术式还原，远优于脚本的通配 `ANTHROPIC_*` 全删。
- **真空白（值得集成）**：清理**别家中转站**的竞争性残留 —— 它们会盖过 / 改写 GFA 的注入，导致接管不生效。

## 1. 要解决的三类冲突

| # | 竞争源 | 冲突机理 | 优先级 | GFA 现状 |
|---|---|---|---|---|
| C1 | `managed-settings.json`（`/Library/Application Support/ClaudeCode/` · `C:\ProgramData\ClaudeCode\` · `/etc/claude-code/`） | Claude Code 里**优先级最高**的一层，会盖过 GFA 写进 `~/.claude/settings.json` 的注入 | 高 | ❌ 未检测 |
| C2 | cc-switch 托盘进程 + `~/.cc-switch`（SQLite 真相源） | 常驻，接管后会把 `settings.json` 的 provider **改写回**别家中转，事后覆盖 GFA | 高 | ❌ 未处理 |
| C3 | OS 级 / shell rc 里的 `ANTHROPIC_*`（User/Machine 环境变量、`.zshrc`/`.bashrc`/`.profile` 的 `export`） | 用户手工 export 了别家 `ANTHROPIC_BASE_URL`/`AUTH_TOKEN`，与 settings.json 注入并存、来源不透明 | 中 | ❌ 未清 |

> C1、C2 是"接管写了却不生效"的**高确定性**根因；C3 是常见的隐性来源。

## 2. 明确不做（红线）

1. **白名单 GFA 自己**：凡指向 `http://127.0.0.1:<proxyPort>` 或 `ANTHROPIC_AUTH_TOKEN=bcai-claude-proxy`
   （见 `claude_inject.go:35` `claudeSentinelAuthToken`）的配置**一律不动**。只清"别家"。脚本的通配删除没有这个概念，直接照搬会删掉 GFA 自己的注入。
2. **不碰登录凭据 / 账号态**：接管场景下 GFA 是**写假凭据**来接管的（`mitm_credentials.go`）。
   预检**不删** `~/.claude/.credentials.json`、不清账号，否则与接管自相矛盾。本方案只清"中转配置"，不清"账号"。
3. **改用户 shell rc / 系统环境变量 = 破坏性外向操作**：必须"先检测 → 展示清单 → 用户确认 → 备份 → 再改"，
   任何一步都不静默执行。备份沿用 GFA 既有 `.bcai-*-backup.json` 风格。

## 3. 架构设计

不移植 `.ps1`（客户端是跨平台 Wails，不能依赖 PowerShell）。用 Go 重写为**检测 / 清理**两能力 + 三平台实现。

### 3.1 新增文件

```
apps/app/claude_env_sanitize.go          # 平台无关：类型、白名单判定、编排、备份
apps/app/claude_env_sanitize_darwin.go   # macOS：shell rc、managed-settings 路径、cc-switch 进程/目录
apps/app/claude_env_sanitize_windows.go  # Windows：User/Machine 环境变量（registry）、UAC、cc-switch 托盘
apps/app/claude_env_sanitize_other.go    # Linux：shell rc、/etc/claude-code
```

> 平台拆分沿用现有 `mitm_os_{darwin,windows,other}.go` 的 build-tag 模式，保持一致。

### 3.2 对外接口（Wails 绑定，注册到 `app.go`）

```go
// 只扫不改。返回结构化冲突列表，供前端展示。
func (a *App) DetectCompetingClaudeConfig() ([]ClaudeConfigConflict, error)

// 备份后清理指定冲突项。ids 来自 Detect 的结果，避免"检测到 A 却清了 B"。
func (a *App) SanitizeCompetingClaudeConfig(ids []string) (SanitizeReport, error)
```

```go
type ClaudeConfigConflict struct {
    ID       string // 稳定标识，Detect→Sanitize 之间引用
    Kind     string // "managed-settings" | "cc-switch" | "os-env" | "shell-rc"
    Scope    string // "user" | "machine" | "process"
    Location string // 文件路径 / 变量名 / 进程名
    Detail   string // 例如 ANTHROPIC_BASE_URL=https://other-relay.example
    Severity string // "blocking"(C1/C2) | "warning"(C3)
    IsGFA    bool   // 命中白名单则 true，且不会出现在返回列表里（此字段仅供内部日志）
}

type SanitizeReport struct {
    Cleaned  []string // 已清理的冲突 ID
    Skipped  []string // 被占用/无权限/用户未勾选
    BackupTo string   // 备份目录，可回滚
    NeedsUAC bool     // Windows Machine 级变量需提权时置位
}
```

### 3.3 白名单判定（核心）

```go
func isGFAOwned(val string, proxyPort int) bool {
    // BASE_URL 指向本地代理端口，或 AUTH_TOKEN 为哨兵值 → 是 GFA 自己，跳过
    return strings.Contains(val, claudeProxyBaseURL(proxyPort)) ||
           val == claudeSentinelAuthToken ||
           strings.Contains(val, "127.0.0.1") // 兜底：本地回环一律视为自己人
}
```

## 4. 接管流程接入点

在 `takeover.go` 的 inject 路径接入（针对 `claudeCodeTarget` / `claudeDesktopTarget`）：

```
用户点"接管 Claude Code"
      │
      ├─(1) DetectCompetingClaudeConfig()        ← 新增预检
      │        │
      │        ├─ 无冲突 → 直接走现有 Inject()
      │        └─ 有冲突 → 前端弹窗展示清单（见 §5），用户决定
      │
      ├─(2) 用户确认清理 → SanitizeCompetingClaudeConfig(ids)（备份）
      │
      └─(3) 现有 Inject()（写 settings.json + 注入哨兵）
```

> 预检**独立于** Inject，失败不阻断（除非是 C1/C2 blocking 且用户选择"仍要接管"时给出明确"可能不生效"提示）。

## 5. 前端交互（`TokenSourceControl.tsx`）

接管点击后，若 `DetectCompetingClaudeConfig()` 返回非空，弹出**带封号免责声明的确认框**（见 §5.1）：

- 动态列出检测到的每条第三方中转项（cc-switch / 别家 `ANTHROPIC_BASE_URL` / 别家 managed-settings…）
- **勾选框「我已知晓风险」——不勾则「清理」按钮禁用**（免责声明生效的前提是用户明确确认）
- 两个按钮：**已知晓，清理并接管**（走 §4 全流程） / **仍要接管**（跳过清理，附"可能不生效"红字）
- Windows Machine 级变量 / `managed-settings.json` 需提权时，复用现有 `CA_FAILED:` 那套 UAC 提示风格
- 清理后展示 `SanitizeReport.BackupTo` 备份目录路径，告知可回滚

### 5.1 第三方中转封号免责提示（弹窗文案）

> **决策：对「所有第三方中转」统一弹此提示**——凡检测到非 GFA 自己的中转配置（cc-switch、别家中转地址、别家下发的 managed-settings 等）均触发。不勾选「我已知晓」不放行。
> **文案重点点名 cc-switch**：检测到 cc-switch 时，将其置顶、加粗、单列一句强提示；其余第三方项列在其后。

```
⚠️ 检测到第三方中转配置

【重点】检测到 cc-switch —— 使用 cc-switch 切换/共享账号极易触发官方风控，
封号风险最高，强烈建议清理。

你的电脑上还存在以下第三方中转配置：
  · 中转地址：https://xxx.other-relay.com
  …（动态列出其余实际检测到的项）

使用第三方中转容易触发官方风控，存在账号被封的风险。
我们将帮你清理这些配置。

因使用 cc-switch 等第三方中转导致的账号封禁，本软件概不负责。

☐ 我已知晓上述风险

[ 已知晓，清理 ]   [ 取消 ]
```

> 注：若本机**未**检测到 cc-switch，则隐藏「重点」那一段，只列实际命中的第三方中转项，其余文案不变。

## 6. 各平台清理动作对照

| 冲突 | macOS / Linux | Windows |
|---|---|---|
| C1 managed-settings | **备份→提权删**（osascript admin）`/Library/Application Support/ClaudeCode/managed-settings.json`（Linux `/etc/claude-code/`）；删后复检**是否被 MDM 重新下发** | **备份→提权删**（`-Verb RunAs`，同 `mitmInstallCAElevated`）`C:\ProgramData\ClaudeCode\managed-settings.json`；删后复检是否复活 |
| C2 cc-switch | 结束 cc-switch 进程 + 备份删 `~/.cc-switch`（含 SQLite）| 同左；Machine 级需 UAC |
| C3 OS env | 从 `.zshrc`/`.bashrc`/`.profile`/`.zprofile` 移除非 GFA 的 `export ANTHROPIC_*` 行（逐行备份 `.bak`）| `[Environment]::SetEnvironmentVariable(...,$null,'User'/'Machine')` 等价的 registry 写入 |

> 所有"改文件"动作先整体备份到统一目录，删除后**复检**是否残留（被占用则标 Skipped，不假装成功）——沿用脚本已验证过的稳健写法。

## 7. 复用脚本已踩过的坑（直接采纳的经验）

- **先杀 cc-switch 再清**：否则前脚删、后脚被托盘写回（脚本 [1/10] 的教训）。
- **shell rc 用 LF 换行**：给 bash/zsh 文件写回时别塞 CRLF。
- **删前备份 + 删后复检**：区分"真删掉"与"被占用没删掉"。
- **代理变量只提示不删**：`HTTP_PROXY`/`HTTPS_PROXY` 可能是用户科学上网/公司代理，误删断网 —— 本方案同样**不动**这些，只在检测报告里提示。

## 8. 交付拆分（便于分批评审 / 实现）

1. **P1 — 只读检测**：`DetectCompetingClaudeConfig` + 三平台扫描 + 白名单判定。零风险，先让客户端能"看见"冲突。
2. **P2 — 清理 + 备份**：`SanitizeCompetingClaudeConfig` + 统一备份/复检/回滚。
3. **P3 — 接管流程接入 + 前端弹窗**：`takeover.go` 预检 + `TokenSourceControl.tsx` 交互。
4. **P4 — 独立"一键体检"入口**（已确定）：不接管也能手动跑一次检测/清理，兼作支持工具。

## 8.1 实现状态（后端 P1 + P2 已落地，TDD）

**已完成（Go 后端，全程 test-first，整包测试绿、darwin+windows 交叉编译过）：**

- `apps/app/claude_env_sanitize.go` —— 检测：`isGFAOwnedRelayValue`（白名单红线）、`scanSettingsEnvConflicts`、
  `detectCcSwitch`、`scanShellRCConflicts`/`exportedThirdPartyBaseURL`、`detectManagedSettings`+`managedSettingsPath`、
  `parseRegQueryValue`、编排器 `detectCompetingClaudeConfig`。
- `apps/app/claude_env_sanitize_clean.go` —— 清理：`backupFileTo`、`sanitizeSettingsEnvBaseURL`、`sanitizeShellRCFile`、
  `moveCcSwitchDir`、编排器 `sanitizeCompetingClaudeConfig`（备份→删→删后复检）；**Wails 绑定**
  `(*App).DetectCompetingClaudeConfig` / `(*App).SanitizeCompetingClaudeConfig`（用 `effectiveProxyPort()`）。
- `apps/app/claude_env_sanitize_{windows,other}.go` —— 平台副作用：`scanOSEnvConflicts`（Win 读注册表）、
  `killCcSwitchProcess`、`deleteManagedSettingsElevated`（mac osascript admin / Win RunAs）、`deleteOSEnvVar`（Win reg delete）。
- `apps/app/claude_env_sanitize_test.go` —— 覆盖白名单红线、各来源检测、编排、清理+复检、App 绑定端到端。
- Codex 按 **D7** 排除。红线有端到端复验：GFA 自己的注入（`127.0.0.1`+`bcai-claude-proxy`）不会被误报/误清。

**P3 + P4 已完成（前端，tsc 0 错误、vitest 116 全绿）：**

- `frontend/wailsjs/go/models.ts` + `App.d.ts` + `App.js`：新增 `ClaudeConfigConflict`/`SanitizeReport` 与两个绑定。
- `frontend/src/services/wails.ts`：`detectCompetingClaudeConfig` / `sanitizeCompetingClaudeConfig` 包装 + 类型导出。
- `frontend/src/components/CompetingRelayDialog.tsx`：免责弹窗 + `useCompetingRelayGate` hook。cc-switch 置顶点名、
  「我已知晓」不勾则「清理」禁用、三态结果 clean/skip/cancel。
- `frontend/src/components/TokenSourceControl.tsx`：`preflightSanitize` 接入 claude / claude_desktop 的 inject 路径
  （接管前检测→弹窗→清理）；页脚新增 **P4「一键体检」按钮**（`handleCheckup`，不接管也能查/清）。
- `frontend/src/i18n/locales/{zh-CN,en}.ts`：`takeover.sanitize.*` 文案（zh-CN 为全语言 fallback 基底）。
- `frontend/src/components/TokenSourceControl.test.tsx`：新增体检检出 cc-switch（勾选门控）+ 无冲突两条用例。

> 接管流程接入选择在**前端** `TokenSourceControl` 的 toggle handler 里做（inject 前调 preflight），
> 未改 `takeover.go` —— 前端拦截更贴近 UI 决策、无需改动后端接管编排，效果等同 §4 的预检。

**仅剩需真机验证（本机 darwin 无法单测的平台副作用，均复用 GFA 既有成熟模式）：**
managed-settings 提权删（mac 密码框 / Win UAC）、cc-switch 进程结束、Windows 注册表读/删。删后复检会兜住失败项（留在 `Skipped`）。

## 9. 已定决策（本轮拍板）

- **D1 免责提示范围**：对**所有第三方中转**统一弹「封号免责」提示（见 §5.1），带「我已知晓」勾选，不勾不放行。
- **D2 managed-settings.json**：**照删**——提权（复用 CA 那套 UAC/osascript admin）+ 备份 + 删后复检是否被 MDM 重新下发；不再走"只提示"。
- **D3 备份 + 复检**：所有破坏性动作先备份、删后复检，被占用/复活则如实标注，不假装成功。
- **D4 cc-switch 进程**：检测到在运行则**直接结束进程**（无需用户手动退出），再清其配置——避免托盘把配置写回。
- **D5 shell rc 清理**：`.zshrc`/`.bashrc` 等里的第三方 `export` 行，弹窗里**默认勾选**清理（用户可取消勾）；改前逐行备份 `.bak`。
- **D6 独立「一键体检」入口**：**保留**。客户端提供一个独立按钮，不接管也能手动跑「检测→（带免责弹窗）清理」全流程，兼作客服排障工具（对齐原脚本定位）。P4 由"可选"升为**确定交付**。
- **D7 Codex 不纳入范围**：本期只做 Claude（Code / Desktop）侧的竞争中转检测与清理，**不检测/不清理 `~/.codex` 相关配置**。Codex 竞争检测留待后续另议。

## 10. 待确认问题（剩余）

- 无。产品决策已全部拍板（D1–D6），可进入实现。

---

*本文仅为设计评审稿，不含代码改动。评审通过后按 §8 分批实现。*
