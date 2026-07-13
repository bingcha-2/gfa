# SQLite 写入压力治理设计

## 背景

2026-07-13 的 Anthropic 额度排查显示，请求没有重复上报，但生产日志持续出现
`Socket timeout`、`Transaction already closed` 和 `Unable to start a transaction`。
当前实现把额度回执、小时聚合、完整 FairShare 窗口快照和派生卡片明细放在同一个请求级事务中；
同时 FairShare、RequestLog、AccountQuotaSnapshot、TokenUsage 和订阅窗口各自按定时器写 SQLite。
FairShare 的 30 秒任务还会在一个全局 `dirty` 标志触发后扫描并写入全部已加载窗口。

本次目标是在不破坏 reportId 防重和小时用量 exactly-once 的前提下，把完整窗口状态从请求热路径移出，
让内存承担实时计算，并把后台写入合并为按 dirty key 的有界、不可重入批次。

## 已确认的持久化边界

- 请求返回成功前，必须原子持久化 `QuotaReportReceipt` 和本次 `CardUsageHourly` 增量。
- FairShare 的 5 小时/周窗口继续以内存状态作为运行时权威状态。
- 完整窗口允许延迟 30 秒合并持久化；同一账号和 bucket 在此期间无论变化多少次，只写最终状态一次。
- 异常进程崩溃可能丢失上次窗口快照之后、最多一个 flush 周期的内存窗口变化；已经提交的 receipt
  和 hourly 用量不会重复。后续上游额度快照负责重新校准母号总剩余。
- 正常退出必须强制刷新 dirty 窗口。

## 方案比较

### 方案 A：最小同步事务 + dirty-key 窗口快照（采用）

请求热路径只提交 receipt 和 hourly，完整窗口在后台按 key 合并写入。该方案显著减少事务时长和
窗口明细写放大，同时保留计费防重。代价是异常崩溃可能丢失最多一个 flush 周期的 FairShare
内存变化。

### 方案 B：所有数据全部异步

请求完全不等待 SQLite，吞吐最高，但异常退出可能同时丢失 receipt 和 hourly，客户端重试会带来
重复计费风险，不满足额度系统的正确性要求。

### 方案 C：维持请求级完整 checkpoint，只开启 WAL 和增加 timeout

改动最小，但删除/重建窗口明细、全池定时刷新和多个写入器竞争仍然存在，只能延后报错，不能消除
写入风暴。

## 目标数据流

1. LeaseService 完成已有的内存/持久化 reportId 防重检查。
2. FairShare reducer 在内存应用 usage 和 quota snapshot 事件，并把 `accountId + bucket` 标记为 dirty。
3. `checkpointReport` 调用新的最小持久化入口：
   - `INSERT OR IGNORE QuotaReportReceipt`；
   - 仅当 receipt 首次插入时，增量 upsert `CardUsageHourly`；
   - 两者处于同一个短事务中；
   - 不更新 `FairShareWindowHead`，不删除或重建 `FairShareWindow`。
4. 最小事务成功后才更新 AccessKeyStore 的内存防重环并向客户端确认。
5. 后台定时器每 30 秒获取 dirty key 快照，串行或以很小批次持久化窗口最终状态。

## 组件设计

### FairShareWindowRepository

把当前 `checkpointBatch` 的职责拆开：

- `checkpointReportAccounting(...)`：只负责 receipt + hourly 的 exactly-once 短事务。
- `checkpointWindows(...)`：只负责 `FairShareWindowHead` 和兼容用的 `FairShareWindow` 明细。

保留 receipt 的 `INSERT OR IGNORE` 作为小时聚合的幂等门。重复 reportId 返回“未插入”，不得再次增加
小时用量。窗口持久化仍保留 revision 防倒退保护。

### FairShareTracker

用 `dirtyKeys: Map<key, revision>` 取代 window-cu 路径上的全局 `dirty`：

- 所有会改变某个窗口的方法只标记对应 key 和最新 revision。
- `checkpointReport` 不再把完整 entry 送入窗口写协调器，只调用最小计费事务。
- 定时 `flush` 只读取 dirty key，不遍历 `windowCu.entries()` 全池。
- flush 成功后，只有 key 当前 revision 不大于已写 revision 时才能清除 dirty；写入期间又发生变化的 key
  必须保留到下一轮。
- flush 失败保留原 key，并使用有上限的退避；不得产生未处理 Promise rejection。
- 同一个 tracker 的 flush 必须 single-flight。

第一阶段保留现有 provider 级 coordinator，但把窗口批次从 64 降到 8～16，避免一个交互式事务包含过多
账号。进程级统一 SQLite 写队列放在第二阶段，避免第一阶段扩大改动面。

### 其他后台写入器

RequestLogTracker、AccountQuotaSnapshotTracker、TokenUsageTracker 和订阅窗口持久化在第二阶段统一增加：

- single-flight 防重入；
- 固定最大批次；
- 失败指数退避和随机抖动；
- 订阅窗口只写状态发生变化的订阅；
- 可观测队列长度、最老事件年龄、批次耗时和重试次数。

这些可观测数据优先级低于额度 receipt，数据库拥堵时不得反向阻塞权威计费写入。

## WAL 策略

WAL 不属于第一阶段根因修复。完成写入合并并通过压力测试后，再单独评估：

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
```

启用时必须同步调整当前“保持非 WAL”的测试和部署备份流程，并验证 checkpoint、`.db-wal` 文件大小及
重启恢复。`busy_timeout` 属于连接级行为，不能假定在 Prisma 的一个连接执行后会自动覆盖所有连接。

## 错误处理与正确性

- receipt/hourly 事务失败：请求不确认，客户端可以使用相同 reportId 重试；内存 reducer 依靠已有的
  reportId 事件去重避免短期重放重复扣减。
- receipt 已存在：不增加 hourly，返回已处理语义。
- 窗口 flush 失败：不影响已经提交的 receipt/hourly；dirty key 保留并退避重试。
- 进程正常退出：停止接收新 flush，等待当前 flush，随后强制刷新剩余 dirty key。
- 进程异常退出：允许损失最近一个 flush 周期的内存窗口变化，但不允许重复小时计费。

## 测试设计

实现严格按 TDD 分步进行：

1. Repository 测试证明最小 report 事务不会调用窗口 head/delete/createMany。
2. Repository 测试证明重复 receipt 不会再次增加 CardUsageHourly。
3. Tracker 测试证明 100 次同 key 更新在一次定时 flush 中只产生一个窗口 checkpoint。
4. Tracker 测试证明只刷新 dirty key，不扫描或写入未变化窗口。
5. Tracker 测试证明 flush 期间再次变更的 key 不会被错误清除。
6. Tracker 测试证明失败保留 dirty key、下一次成功后清除，并且 flush 不重入。
7. LeaseService 测试证明最小事务成功前不会确认或登记 AccessKeyStore 防重环。
8. 运行现有 quota repository、FairShareTracker、LeaseService 和 quota e2e 回归测试。

## 验收标准

- 单次 durable quota report 的事务中不再删除或重建 `FairShareWindow`。
- 同一 key 在一个 flush 周期内只持久化一次最终窗口状态。
- 定时 flush 不写未变化窗口，且不会重入。
- receipt/hourly 保持原子和 exactly-once；重复 reportId 的 hourly 增量为零。
- 模拟 SQLite busy 后队列能够恢复并清空，不出现未处理 rejection。
- 专项测试和现有额度回归测试全部通过。

## 非目标

- 第一阶段不迁移 PostgreSQL。
- 第一阶段不开启 WAL。
- 第一阶段不重写 FairShare 算法或额度分配规则。
- 不修改 RequestLog、Snapshot 等数据的业务含义。
