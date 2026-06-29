# GFA 本地接管(自有号)设计

日期:2026-06-30
状态:已批准方向,待 P0+P1 实现计划
分支:`feat/local-takeover`

## 1. 背景与目标

把 cockpit-tools 的 **codex 全部本地功能 + antigravity 全部本地功能** 复刻进 GFA 桌面客户端(`apps/app`,Wails/Go),作为一种新的「账号来源」。

GFA 现状:客户端已能 MITM/配置注入接管本地 Codex CLI、Antigravity IDE、Claude Code/Desktop,但注入的 token 一律来自**服务端号池(远程租号)**。这就是「远程托管」。

新增:「**本地自有号**」——用户用自己 OAuth 登录的 ChatGPT / Google 账号,本地存储、本地多号网关路由,完全不经服务端号池。账号管理是它的主功能。

范围:codex 全部 + antigravity 全部(不含其余 14 家 provider)。

## 2. 核心概念:两个世界

| | 远程托管(现状) | 本地自有号(新) |
|---|---|---|
| 账号来源 | 服务端号池租号 | 用户自己 OAuth 登的号,本地存 |
| 主功能 | 用量查看 + 接管开关 | **账号管理(丰富)** |
| 数据面 | `proxy.go` 租号链路(注入借来 token,出口指纹受控,单一用途) | 进程内嵌入的 CLIProxyAPI 网关(多号路由/翻译) |
| 统计 | 主页(客户端上报数据) | 本地 suite 统计 tab(网关请求日志) |
| 代码 | `features/remote/*`(基本不动) | `features/local/{codex,antigravity}/*` + `shared/*` |

两个世界 **UI 与代码彻底分离**,只在「同一产品的 `config.toml` 注入互斥」处保留一个极薄协调层。

## 3. 安全不变式(硬边界)

**远程租号绝不允许经本地 CLIProxyAPI 网关代理出口。** 见记忆 [[local-gateway-no-lease-egress]]。

- 两条数据面物理隔离:本地网关只服务自有号(可开 LAN / API key / 通用 `/v1` / 请求日志 / 导出);远程租号走 `proxy.go`,不暴露通用端点、不把原始凭证交给用户。
- CLIProxyAPI 的 auth store **只接受自有号**;用类型/接口在 P0 锁死(lease 根本不实现网关 auth 接口),不靠运行时判断。
- 网关那些「危险」能力一律仅对自有号生效,远程链路一个都不开。

## 4. 与既有 rosetta 的关系(重要)

GFA 服务端已有 CLIProxyAPI 集成,代号 **rosetta**(`apps/server/src/leasing/rosetta/`):服务端维护账号池,同步到一个**远程部署的** CLIProxyAPI 服务,控制台管理。桌面客户端今天**完全不碰** rosetta。

本地接管与 rosetta 的区别与复用:
- **区别**:rosetta = 服务端远程号池 → 远程 CLIProxyAPI。本地接管 = 客户端**进程内**嵌入的本地 CLIProxyAPI 跑**用户自有号**。两者独立,不能互相复用运行时。
- **复用(模式,非代码)**:
  - CLIProxyAPI 的凭证文件 schema(由 CLIProxyAPI 软件定义,服务端/客户端通用):
    - antigravity:`{type:"antigravity", email, project_id, refresh_token, access_token}`
    - gemini:`{type:"gemini", email, project_id, token:{refresh_token}}`
    - codex:CLIProxyAPI codex auth 格式
  - 账号状态模型:`quotaStatus: ok|error|cooling|exhausted`、`blockedUntil`、revision+tokenHash 冲突解决。
  - 错误分类:`invalid_grant`→停号、`429`→模型级冷却、`503`→短冷却、`401`→清 access token。

## 5. 数据面:CLIProxyAPI 进程内嵌入

CLIProxyAPI(`github.com/router-for-me/CLIProxyAPI/v7`,MIT,纯 Go)原生支持 codex + antigravity(+ claude/gemini 等)。它提供专为嵌入设计的 SDK:

- `sdk/cliproxy.NewBuilder().WithConfig(cfg).Build() → *Service`,`Service.Run(ctx)` / `Service.Shutdown(ctx)`。
- `WithConfig(*config.Config)` 代码注入配置(不依赖文件 watcher);`WithCoreAuthManager` / `RegisterUsagePlugin` / `WithPostAuthHook` 让 GFA 控制面接管账号事件与用量回流。

**决策:进程内嵌入**(在 Wails Go 二进制里 goroutine 起 CLIProxyAPI server),理由:同 Go 生态、免跨语言 IPC、免分平台打包 sidecar、配置代码注入、用量/账号直连控制面、生命周期绑定 app。用 supervised goroutine + recover 兜崩溃。**可逆退化**:同一套 Builder API 几乎零改动可编成瘦 sidecar。

P0 待定细节:嵌入**上游** CLIProxyAPI 还是 GFA 的 rensumo fork(若 fork 有报告回调等补丁);go.mod 依赖冲突验证(v7 整树)。

## 6. 控制面(Go 原生新写)

`features/local/*` 下,在 `apps/app` 用 Go 原生实现,复用 GFA 已有注入/MITM/egress:

- 本地账号存储(SQLite,贴合 GFA 现状),单一事实源;CLIProxyAPI 的 auths 由控制面从 DB 同步生成。
- OAuth 登录编排、切号/池启停、配额监控、Wakeup 调度、多实例。
- 接管层复用:本地模式下把 `config.toml` 指向**网关端口**(而非租号 proxy 端口);antigravity 走系统钥匙串 + state.vscdb 注入。

## 7. 接管薄协调层(解决冲突)

`~/.codex/config.toml` 只能指向一个本地端口,injected 状态每产品一个。因此**模式不是第二个接管,而是同一个接管的「号源维度」**:

- 接管页每产品一个 `远程托管 | 本地自有号` 段控 + 接管/停止开关,**单一 injected 状态**(记录按哪个源接管)。
- 后端 inject 加 source 参数 → 决定指向租号 proxy 端口 还是 网关端口。切源 = 重新注入到另一端口(带确认),绝不并存。
- 模式可用性按 provider:只有 codex/antigravity 有「本地」,Claude 仅远程。
- 这是两个世界唯一的耦合点,做成极薄协调层,两侧业务逻辑不互相 import。

## 8. 信息架构(扁平,≤2 层)

参考 cockpit「每 provider 一个 suite 页 + 内部 tab」组织法:

```
侧栏
├─ 远程托管
│   ├─ 主页        ← 远程统计(租号上报)
│   └─ 接管        ← 每产品设「远程/本地」模式 + 开关(薄协调层)
└─ 本地自有号
    ├─ Codex       ← 账号管理 suite:账号 / 网关 / 保活 / 实例 / 统计
    └─ Antigravity ← 账号管理 suite:账号 / 保活 / 实例 / 验证 / 统计
```

- **接管页**:只做选模式 + 开关。本地模式下给「出口=本地网关 · N 号在线 · 管理账号 →」跳转,不嵌账号管理。
- **本地 suite**:`账号` tab 为主功能(同屏主从,选号行内展开详情,不下钻)。
- **统计分离**:远程统计在主页,本地统计在 suite 统计 tab(网关数据),两套数据源。

### 各 tab 内容(复刻 cockpit)

- **账号(主)**:搜索/筛选 chips(全部/在线/额度将满/需重登/分组)/排序/导入(本地·JSON·文件·批量)/导出/登录;行=多选+出口标记+邮箱+账号类型(OAuth/API Key 自备号)+标签+套餐+5h 配额条+状态;行内展开=配额双窗口+重置点数+套餐组织+Token 态+操作(移出池/重新登录/标签/删除)。
- **网关(codex)**:运行态/端口/访问范围(仅本机·局域网)/base_url;路由策略(自动·配额高/低优先·套餐·到期·自定义)+会话粘连+重试+冷却;API 密钥(命名·按模型限权·轮换);模型规则(别名·排除·图像);高级(上游代理·超时预设·调试日志);连通/对话测试。
- **统计**:今日/7天/30天;请求/Token/成本/错误率;按账号 + 按模型;最近请求日志可下钻。
- **保活(Wakeup)**:定时唤醒任务(每号/每模型 cron)、立即运行、历史、唤醒后验证额度真涨(antigravity 走 gRPC MITM 网关)。
- **实例**:多 profile,创建/启停、绑定账号、工作目录、独立 user-data-dir、启动命令。
- **验证(antigravity)**:账号健康批量验证。

## 9. UI / 设计

复用 GFA 客户端真实 token(`apps/app/frontend/src/index.css`):琥珀单色 `#ea580c`、近白 `#f6f7f9` 画布 + 右上琥珀光晕、深靛深色、Inter + JetBrains Mono 等宽数字、8/12/16 圆角、克制(绿/黄/红仅状态语义,无渐变无玻璃)。深浅双主题一等公民。多号长列表用虚拟化(react-window),不铺开;池摘要在前。当前号用琥珀软底+边框高亮(不用侧边色条)。

## 10. 代码分层

```
apps/app/frontend/src/features/
├─ remote/      远程:沿用 TokenSourceControl、Dashboard(基本不动)
└─ local/
   ├─ shared/   公共抽象:账号 store 工厂、配额窗口条、网关状态、provider chip、列表+详情壳、类型
   ├─ codex/    Codex suite(账号/网关/保活/实例/统计)
   └─ antigravity/  Antigravity suite

apps/app/(Go)
├─ 既有:proxy.go / mitm_* / codex_config.go / codex_credentials.go / egress(远程,复用)
└─ local/(新):CLIProxyAPI 嵌入封装、本地账号 store、OAuth、网关生命周期、wakeup、实例;
   接管协调:inject 加 source 参数(本地→网关端口),单一 injected 状态
```

唯一共享耦合 = 接管 source 互斥协调层(极薄)。

## 11. 分解(每阶段独立 spec → plan → 实现)

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P0 地基** | 嵌入 CLIProxyAPI(验 go.mod 冲突)+ 生命周期(supervised goroutine)+ 本地账号 SQLite schema + auths 同步(DB→网关,自有号 only,类型锁死)+ 接管 source 维度协调层 | — |
| **P1 Codex 本地 MVP** | 自有号 OAuth 登录、账号 tab(列表/切号/配额/状态)、网关 tab 基础(端口/路由/API key)、接管指向网关、配额刷新 | P0 |
| **P2 Codex 进阶** | Wakeup、多实例、session/thread 同步、自定义 model provider、请求日志/统计 tab、导入导出/批量 | P1 |
| **P3 Antigravity 本地 MVP** | 自有号 OAuth、系统钥匙串注入、IDE/legacy 双 runtime 切号、切号历史、配额、账号 tab | P0 |
| **P4 Antigravity 进阶** | Wakeup(gRPC MITM 网关)、多实例、验证 tab | P3 |

P1、P3 都只依赖 P0,可并行。首批落地 = **P0+P1 合并(Codex 端到端)**。

## 12. 测试(TDD)

符合 dev 约束 [[dev-working-constraints]](TDD、删触碰文件死代码、单文件 ≤800–1000 行)。

- 控制面 Go 单测:本地账号存储 CRUD、auths 同步(DB→CLIProxyAPI 凭证文件,断言只含自有号)、接管 source 互斥与 config.toml 重写/还原、错误分类、配额窗口换算。
- 安全不变式测试:断言任何 lease 都无法进入网关 auth store(编译期/接口层 + 运行期双保险)。
- 前端组件测试:账号列表筛选/搜索、模式切换、配额条渲染。
- 端到端手验:真实 ChatGPT 号跑通 P1 链路(登号→网关→接管 Codex CLI→出口)。

## 13. 风险

- **go.mod 依赖冲突**:CLIProxyAPI v7 整树并入 `apps/app/go.mod` 可能冲突 → P0 第一步即验证可编译;冲突严重退化 sidecar。
- **CLIProxyAPI 版本/补丁漂移**:固定 commit;明确嵌上游还是 rensumo fork;与服务端 rosetta 用的版本对齐策略。
- **接管双模式互斥**:切换时干净重写 `config.toml` 并恢复 backup,避免端口指向错。
- **复刻遗漏**:实现前并行翻 cockpit 代码,逐特性建复刻清单(账号/网关/保活/实例/统计/导入导出/分组标签/重置点数/referral/session 同步…),纳入各阶段 plan 的验收项。
