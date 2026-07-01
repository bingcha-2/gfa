# GFA 接管中心 IA 重构 — 设计

日期：2026-06-30
分支：feat/local-takeover

## 背景与问题

本地接管(Codex/Antigravity 自有号)功能已落地,但导航信息架构(IA)散乱,与早先设计不符:

- 「接管」开关散在三处:`主页(DashboardPage)` 底部的 `TokenSourceControl`(远程接管),以及每个本地 suite 头部的「接管模式」开关(本地接管)。没有统一入口 —— 即用户说的「分散控制台」。
- `主页` 名为控制台,实则是远程用量看板,却塞了接管面板。
- `日志` + `常见问题(使用指南)` 各占一个一级导航槽,挤占主导航。

早先「拆开 / 层级太深」的约束指的是**代码与数据**的解耦(local/remote 分包、统计分离),该约束保留。本次新增的是另一根轴:**控制面统一** —— 一个集中决定「每个产品走远程还是本地接管」的地方。两者不矛盾:一处**决定接管**,各处**管理各自账号/统计**。

## 目标 IA

左侧导航(自上而下):

| 入口 | 性质 |
|---|---|
| **接管中心** | 新增,默认落地页。每个产品一张卡:模式(远程托管⇄本地自有号)+ 接管/停止。唯一的接管控制面。 |
| **远程** | 原 `主页` 改名。纯远程用量 / 订阅 / 今日明细看板,**移除** `TokenSourceControl`。 |
| **本地自有号 › Codex / Antigravity** | 账号管理 suite(账号/统计/保活/实例)。头部模式开关**移除**,改为只读「当前模式」+ 去接管中心链接。 |
| _(底部 dock)_ | `使用指南` + `日志` + `设置` + `反馈` 收进侧栏底部 dock,主导航更清爽。 |

### 已确认的分工决策

1. **接管中心管开关,远程只看用量**:接管中心统一控制所有产品(含 Claude)的接管开关与模式;`远程` 页不再有任何接管按钮,只读用量/订阅/明细。
2. **模式只在接管中心切**:本地 suite(Codex/Antigravity)头部不再有「接管模式」开关,改为只读显示「当前:本地自有号 / 远程托管」+ 一个跳转接管中心的链接。suite 专注账号/统计/保活/实例 + 登录新账号。
3. **日志 + 使用指南收进底部 dock**(设置旁)。

## 接管中心页(TakeoverCenterPage)

每个产品一张行卡,统一结构:图标 + 名称 + 副标题(状态摘要)+ 模式段控(若适用)+ 接管/停止按钮。

- **Claude Desktop / Code / Cowork**:仅远程托管(MITM 接管,无本地自有号模式)。复用现有 `TokenSourceControl` 的接管/还原逻辑(含 macOS 权限引导、CA 降级、商店版拦截、出口前置闸等所有现有分支语义,逐字迁移,不简化)。
- **Codex**:模式段控 `远程托管 | 本地自有号`,互斥。
  - 远程托管 = 现有远程接管路径(IDE 配置指向远程代理 / 通行证)。
  - 本地自有号 = `LocalSetCodexSource('local')`:指向本地网关 `127.0.0.1:<port>`,自动启网关 + 注入。
  - 切换即接管:选中某模式 = 用该模式接管;「停止」= 还原(`LocalSetCodexSource('remote')` 还原本地注入,或远程路径的 Restore)。
- **Antigravity**:同 Codex,本地 = `LocalSetAntigravitySource('local')`(IDE settings 指向本地网关)。

### 互斥不变式

Codex/Antigravity 的远程接管与本地接管**写入同一份 IDE/CLI 配置**,二者互斥。接管中心负责协调:切到「本地自有号」前先还原远程注入,反之亦然;任一产品任一时刻最多一种接管生效。这条在卡片状态机里强制,避免双重注入。

安全不变式不变:**远程租号绝不经本地网关出口**;本地网关只服务自有号(见 memory `local-gateway-no-lease-egress`)。接管中心只是同一前端壳上的两个互斥控制,不改变两条数据面的物理隔离。

## 本地 suite 头部改造

`LocalProviderSuite` 头部:
- 移除 `supportsSource` 的「接管模式」段控块。
- 移除「启动/停止网关」按钮(网关生命周期由接管中心的接管动作驱动:切到本地即启,停止即关)。
- 改为只读状态条:`当前:本地自有号 · 网关 127.0.0.1:<port> 运行中` / `当前:远程托管`,右侧一个文字链接「去接管中心 →」(切页到 `takeover`)。
- 「登录新账号」保留在 suite(账号管理是 suite 的职责,在账号 tab 内,已有)。

`supportsSource` prop 及 `onSwitchSource`/`source` 状态从 `LocalProviderSuite` 移除;读取当前模式改为只读 `api.getSource()` 展示。

## 路由与导航改动

- `PageId`:`'home'` → `'remote'`;新增 `'takeover'`。最终集合:`'takeover' | 'remote' | 'logs' | 'faq' | 'settings' | 'local_codex' | 'local_antigravity'`。默认落地页 = `'takeover'`。
- `App.tsx`:`takeover` → `<TakeoverCenterPage />`;`remote` → `<DashboardPage />`(去掉 TokenSourceControl)。
- `Sidebar.tsx`:主导航 = [接管中心, 远程] + 分组 [Codex, Antigravity];底部 dock 增加 `使用指南`、`日志` 入口(`设置`/`反馈` 已在 AccountDock,沿用)。
- i18n:`nav.home` 文案改为「远程」,新增 `nav.takeover`「接管中心」。

## 复用与解耦

- 接管中心的 **Claude 卡** 抽取 `TokenSourceControl` 现有的产品行 + 接管执行 hook,使其可单独渲染一行;不复制接管逻辑,提取共享。
- 接管中心的 **Codex/Antigravity 卡** 调用既有 `localApi.getSource/setSource` + 远程接管绑定;模式协调逻辑放接管中心页,suite 不再持有。
- 后端绑定(`local_bindings.go` / hub)无需改动 —— 已具备 getSource/setSource/gatewayStart/stop;接管中心只是换了前端调用位置。

## 测试

- `TakeoverCenterPage` 组件测试:三张卡渲染;Codex 卡模式段控点击 → 调 setSource('local'/'remote');Claude 卡接管/停止 → 调对应绑定;互斥(切本地前还原远程)。
- `LocalProviderSuite` 测试更新:断言头部不再有模式段控、改为只读状态 + 去接管中心链接;移除原 supportsSource 用例。
- `DashboardPage` 测试:断言不再渲染 `TokenSourceControl`。
- Sidebar 测试:断言导航项 = 接管中心/远程 + 本地分组;日志/使用指南在底部 dock。
- 后端 hub 测试无改动(行为未变)。

## 非目标(YAGNI)

- 不做「网关仅 API / 不注入 IDE」的高级模式(后续再议)。
- 不改两条数据面隔离、不改 hub/绑定后端逻辑。
- 不做接管中心的批量一键接管(逐产品控制足够)。
