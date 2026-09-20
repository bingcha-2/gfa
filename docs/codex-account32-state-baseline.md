# 母号 32 STATE 基线观察

日期：2026-09-20。用户指定母号 32。本次仅一次手动上游生成请求，沿用账号原绑定代理、现有身份配置；未修改生产配置、未换出口、未重试、未跨轮注入 STATE。测试使用账号上游额度，不记入客户订阅用量。

## 结果

- 请求：gpt-6-astra，reasoning effort=high，简单算术 17×23。
- HTTP：200。
- 生成终态：failed。
- 错误码：invalid_prompt。
- 响应中观察到的模型：gpt-6-astra（失败响应，不是完整成功响应证明）。
- x-codex-turn-state：292 字节；仅记录长度，原文未保存或打印。
- 解析用量：0 token；不代表上游实际资源消耗必然为零。
- 耗时：2745 ms。

该样本说明：长度 292 的 STATE 与 invalid_prompt 可以同时出现。因此长度 292 不是请求成功或模型质量保证。失败基线不提供可验证的有效状态，本次没有继续复用或反复采集。测试程序 PASS 只表示正常结束，不代表模型请求成功。

## 新证据与试验边界

OpenAI Codex 的 client.rs 明确把 x-codex-turn-state 定义为同一轮内的 sticky routing 状态，要求本轮后续请求保持原值，跨轮重新创建状态；跨轮复用可能产生路由错误：
https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs

这与社区文章的跨轮账号级票据复用建议存在实质差异。后续应先验证正常同轮透传和最小请求的 invalid_prompt 原因，不把 292 长度作为绕过错误的依据。

原始脱敏摘要：`.tmp/state32-baseline.json`。手动测试文件：`apps/app/codex_state32_experiment_test.go`；默认跳过，仅显式 GFA_STATE32_EXPERIMENT=run-once 时触发，固定只允许母号32和一次请求。未部署或推送该试验。

## 后续对照（2026-09-20）

用户授权后增加两次对照，均使用母号 32 的当前凭据及原绑定代理，未刷新凭据、未换出口、未注入 STATE。

| 路径 | 请求模型 | 响应模型字段 | 结果 | 耗时 |
| --- | --- | --- | --- | --- |
| GFA 现有传输函数，最小 Responses 请求 | gpt-5.6-sol | gpt-6-sol | HTTP 200，流内 failed / invalid_prompt | 2353 ms |
| 已安装官方 CLI 0.154.0-alpha.6.2，隔离目录、显式官方后端 provider、HTTP | gpt-6-astra | CLI 未提供 | turn.failed，同样的策略相关 Invalid prompt，进程退出 1 | 3899 ms |

Sol 对照 response ID：`resp_03d349d38ab6bf23016aaffd53b09487d2ab6220fe27aa658e`。STATE 长度仍为 292，解析用量 0，不代表上游实际消耗为零。失败响应中的模型字符串不能证明实际完成了该模型的推理，也尚未确认是否为别名。

官方 CLI 测试未使用主 CODEX_HOME；关闭用户配置、规则、apps/plugins/multi_agent 和请求/流重试，空目录、只读沙箱，无客户项目输入。通过仅传给子进程的环境变量提供现有 access token 与账号头，代理也是子进程环境设置。为避免修改登录和刷新凭据，使用显式 backend provider，而不是重新走 ChatGPT 登录；因此这不是完整的官方交互登录对照。没有经过 GFA 的请求转码、响应解析和租约调度。

结论：Sol 暂不能作为此账号的已验证替代。两条独立请求构造路径都被拒绝，GFA 响应转码/调度不太可能是唯一原因。账号、同一绑定代理出口及上游处理仍是共同变量，不能据此认定已封号或已经排除出口因素。停止重复试探，保留证据用于上游复核。

脱敏记录：`.tmp/state32-sol-control.json`、`.tmp/state32-cli-report.json`。这些请求消耗母号测试额度，不计客户账单；生产配置未改变。
