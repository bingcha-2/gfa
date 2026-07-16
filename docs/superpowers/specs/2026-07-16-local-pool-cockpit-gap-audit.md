# 本地号池与 cockpit-tools 功能核查

日期：2026-07-16

范围：GFA 的 Codex / Antigravity 本地自有号，与 `/Users/caoyifan/Documents/github/cockpit-tools` 中对应账号管理能力。cockpit-tools 只作为实现参照，不要求无差别照搬。

## 结论

GFA 不是“只有一个账号列表”。账号池、额度、分组、优先级、导入导出、网关、保活、统计、会话、Codex 设置和 Antigravity 本地接管这些主链路已经存在。当前最严重的问题在 OAuth 登录状态管理：旧界面把弹窗是否存在绑定到 `loginId`，任何等待或提交错误都会卸载回调输入框。这一项已在本次修复。

与 cockpit-tools 相比，剩余真正影响可靠性的差距主要是：授权链接的显式控制、端口冲突诊断、可恢复的批量导入任务。批量删除任务和高级路由属于后续增强，不应与登录故障混在一起。

## 功能矩阵

| 能力 | GFA 当前状态 | cockpit-tools 参照 | 判定 |
| --- | --- | --- | --- |
| OAuth 登录会话、自动等待、手动回调、取消 | 已有；本次改为持久弹窗和显式状态机，失败不再清空输入 | `src/services/codexService.ts` 的 start/complete/submit/cancel；`CodexAccountsPage.tsx` 持久维护 URL、超时和错误状态 | P0 已修 |
| 授权链接显示、复制、重新打开 | 后端 SDK 自动打开浏览器，`LocalStart*Login` 只返回 login ID，前端拿不到 auth URL | start 返回 `{ loginId, authUrl }`，页面可复制和重新打开 | P1 缺口 |
| OAuth 端口冲突、关闭占用端口、无痕窗口 | 未提供专项诊断或入口 | `isCodexOAuthPortInUse`、`closeCodexOAuthPort`、`openCodexOAuthIncognitoWindow` | P1 缺口 |
| 账号 CRUD、池开关、当前账号、优先级、顺序 | 已有 | 已有 | 已覆盖 |
| 分组、名称、备注、标签 | 已有 | 已有 | 已覆盖 |
| OAuth token / API Key / JSON / 文件 / 本机导入 | 已有；导入直接执行，只返回新增数 | 已有，并提供批量任务、预览、确认、失败项、取消/恢复 | P1 部分覆盖 |
| 批量删除进度、暂停、恢复、失败重试 | 直接删除，无独立任务状态 | `start/get/pause/resume/retryCodexBatchDelete` | P2 缺口 |
| 单账号及全量额度刷新、Codex 双周期、Antigravity 多桶额度 | 已有 | 已有 | 已覆盖 |
| Codex 订阅、重置额度、推荐奖励 | 已有 | 已有 | 已覆盖 |
| 超额预警、自动切号 | 已有 | 有相近策略 | 已覆盖 |
| 本地网关、访问密钥、代理、路由策略、请求日志、超时、图片生成 | 已有核心能力 | 有更细的账号/模型规则、定价与调试项 | P2 部分覆盖 |
| 统计、保活、执行历史与验证 | 已有 | 已有 | 已覆盖 |
| Codex 会话搜索、回收站、恢复、跨实例修复 | 已有 | 已有，另有更丰富的导入导出预览 | 核心已覆盖 |
| Codex 快捷设置、模型供应商 | 已有 | 已有 | 已覆盖 |
| OAuth 账号绑定、待完成 OAuth 草稿账号 | 未形成独立对象模型 | `updateCodexApiKeyBoundOAuthAccount`、`createPendingCodexOAuthAccount` | P2 缺口 |
| Antigravity IDE 同步、独立/IDE 接管变体 | 已有 | 有相近的运行时/账号管理 | 已覆盖 |

## 本次登录修复

- 登录弹窗先打开，再启动后端会话；后端失败不会导致界面消失。
- UI 状态拆分为 `starting / waiting / submitting / success / error`，不再用一个全局 busy 状态糊住所有阶段。
- 回调输入框在等待和错误状态始终存在；提交失败保留原值，可原地修正。
- 使用 Wails 原生剪贴板读取，减少 WebView 剪贴板权限导致的“粘贴没反应”。
- 取消会显式取消后端会话；重试会隔离旧异步结果，避免旧请求覆盖新会话。
- Codex 与 Antigravity 共用同一登录组件，因此两端同时获得修复。

## 本次号池界面重构

- 撤掉四宫格统计、独立分组侧栏和自动化卡片，整个号池收敛为一个扁平账号工作区，避免“仪表盘套仪表盘”。
- 账号总数、已入池和需处理改为一句状态摘要；分组改为横向文字筛选，统计口径跟随当前分组。
- 增加全部、已入池、需处理三种状态视图，并支持名称、邮箱、备注和标签搜索。
- 增加当前视图全选，批量操作改为显式的选择状态条。
- 搜索和添加账号是唯一明显的主操作，导入、导出、刷新额度保持次级；账号行固定为账号身份、剩余额度、池状态与操作三层结构。
- Codex 双周期和 Antigravity 多额度桶使用同一对齐规则，异常额度保留红黄绿语义。
- 重新设计加载、空号池、无搜索结果三种状态；深色和浅色模式均完成真实界面验收。

## 后续优先级

1. P1：重构登录后端，使 start API 返回 `authUrl` 和端口信息；前端增加“复制链接 / 重新打开 / 无痕打开 / 端口冲突处理”。现用 CLIProxyAPI SDK 的登录入口只返回账号结果，需升级 SDK 接口或在 GFA 层接管 OAuth URL 生成，不能只靠前端补按钮。
2. P1：把文件导入改为可预览、可确认、逐项报错的批量任务；大号池导入失败时不再只显示一个总数或总错误。
3. P2：大批量删除增加进度、失败项重试和恢复；小批量仍保留直接删除。
4. P2：只按实际网关需求补账号/模型级路由和调试能力，不机械复制 cockpit-tools 的全部设置。

## 代码证据

- GFA 账号 API：`apps/app/frontend/src/services/localApi.ts`
- GFA 共用账号界面：`apps/app/frontend/src/features/local/shared/LocalAccountsTab.tsx`
- GFA OAuth 绑定：`apps/app/local_bindings_oauth.go`
- GFA 登录管理器：`apps/app/internal/local/manager/manager.go`、`login_manual.go`
- cockpit-tools Codex API：`src/services/codexService.ts`
- cockpit-tools Codex 页面状态机：`src/pages/CodexAccountsPage.tsx`
