# Claude 网关套餐限额

Claude Code 与 Desktop 使用同一个 GatewayUser 和账单；Codex 仍走独立订阅与母号池。

完整业务链路及迁移交接见 [Claude 拼车业务逻辑与上游迁移说明](claude-carpool-migration.md)。

## 配置及绑定

- 后台套餐目录的每份 5 小时 / 每周额度，在购买时展开并保存为 Subscription.config.usdQuotaByProduct.anthropic。0 表示该 GFA 窗口不启用，不代表上游无限制。当前发布目录会同步重算有效绑定订阅的额度，保留用量和窗口；发布确认框明确提示此行为。后续若要锁定旧套餐权益，应另行拆出显式批量调整操作。
- 用户通过 GatewayUser.customerId 关联订阅，通过 GatewayUser.motherAccountId 绑定 GatewayMotherAccount。母号保存上游账号名及该账号的加密私有 Key。
- Pro/Ultra 标签不自动匹配或迁移母号。分配网关份额时可指定母号，否则优先选择剩余参考份数最多且 ready 的母号，满额后仍可超配。总份数仅供参考，不是分配硬上限；新增分配和增加份数仍要求有效 Claude 订阅。多位 GFA 用户可共享同一母号。
- 订阅未配置有效的 usdQuotaByProduct.anthropic 时，按配置无效处理，不再使用份额乘后台 shareUsd 的旧兜底。不会用模型价格推算订阅容量。

## 校验及账单

每次推理都检查有效 Claude 订阅、账户状态、两个个人窗口和母号观测到的额度。个人窗口或上游已确认用满时返回 429；有效恢复时间返回 Retry-After。上游 unknown/uncertain 本身不单独拦截，最终仍受上游准入约束。关闭个人窗口不能绕过上游限制。

请求按订阅优先级选择有余额的 Claude 订阅；记录 subscriptionId 与 occurredAt，用请求发生时间的价格快照计费。窗口用量从账单聚合，5 小时恢复不会清除每周用量。迁移前无 subscriptionId 的旧账单仅归入当前第一份有效 Claude 订阅，避免多份重复扣除。

有可信上游周期边界时使用该边界；过期且没有新读数时不在本机推断上游补满。没有上游边界时，个人窗口以订阅开始时间分段。人工重置以 quotaResetAt 为账单截断时间，累计账单保留。

客户端展示套餐个人限额的剩余百分比和恢复时间；未启用的窗口不显示。上游缺失读数不等于 100% 或无限制，也不覆盖已知的 GFA 账单比例。上游仍对转发的请求实施自己的限制；无观测值不能保证其可用性。

当前按已完成请求结算，并发请求可能同时在余额耗尽前获准；不宣称绝不超额。既有每用户并发限制保留。

## 验证

- gateway-pool 单元测试：资格、两个窗口、记账、转发、上游边界。
- GatewayUsagePanel / DashboardPage：双进度条、关闭 5 小时、未知数据、绿/红语义及 Claude/Codex 隔离。
- 后台目录表单、页面及购买价格测试。
- 本地 SQLite 副本结合真实 GatewayUserService + GatewayForwardController：成功请求落账、5h 429、关闭 5h 后放行、7d 429、过期及 Codex-only 403。该测试模拟上游模型响应，不能代替上游真实模型验收。
