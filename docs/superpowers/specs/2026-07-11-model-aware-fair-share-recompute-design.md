# 模型加权的公平额度实时重算设计

> 日期：2026-07-11
> 状态：待评审
> 范围：Codex、Anthropic 绑定账号的 5 小时与周额度
> 不包含：Antigravity、历史窗口归档、自动回滚、按模型拆分额度池

## 1. 结论

本次改造采用“官方模型费率换算 CU + 母号真实快照校准 + 当前窗口累计重算”。

每次请求完成后，系统按真实模型、输入 Token、缓存 Token、输出 Token和速度档换算成标准消耗单位 CU，并累计到当前 5 小时窗口和周窗口。母号额度快照每次发生可信变化时，系统使用整个窗口累计 CU 重新计算所有绑定用户的归因结果。

本次只保留两个窗口：

- 5 小时窗口独立累计、独立计算、独立显示。
- 周窗口独立累计、独立计算、独立显示。

Sol、Terra、Luna、Fable、Opus 等模型不创建独立额度池。模型只决定一次请求折算成多少 CU。界面不把两个窗口合并为一根“最低血条”；是否允许继续请求时，任一真实窗口耗尽即可拦截。

所有产生上游 usage 的模型请求都必须计入，包括自动补全和未来尚未识别的新模型。模型是否便宜、是否属于辅助功能，只影响倍率，不能成为跳过计量的理由。只有请求失败且上游 usage 确实为零，或官方明确证明某类调用不消耗母号额度时，才允许记零。

不新增历史窗口表。官方 reset 后清理当前窗口状态。现有 `CardUsageHourly` 仅用于排障和近似复算，不承诺精确恢复已经关闭的窗口。

## 2. 问题定义

用户反馈的主要症状是：

1. 用户只问了少量问题，个人额度突然降到零。
2. 过一段时间，个人额度又恢复。
3. 同样的真实用量，因为轮询时机不同，最终归因可能不同。
4. 不同模型消耗差异明显，但当前 Codex 统一按同一套 Token 权重计算。

当前 `FairShareTracker` 把 `perCard` 定义成“自上次母号下降以来的增量用量”。每次发现母号下降，就按这一小段用量分配下降量，然后立即清空 `perCard`：

```text
母号下降一段
→ 按当前 perCard 分摊
→ 清空 perCard
```

如果上游把同一次大请求造成的消耗分几次延迟上报，第一次下降会分给真正的大请求用户并清空记录；另一位用户随后发出小请求，第二次延迟下降便可能主要甚至全部算给后者。

模型权重还有独立问题。当前 Codex 基本使用统一的：

```text
净输入 × 1 + 缓存输入 × 0.1 + 输出 × 8
```

并把 Fast 统一乘以 1.5。这与当前 OpenAI 官方 Credits 费率不一致，也没有体现 Sol、Terra、Luna 之间的绝对消耗差异。

## 3. 官方依据与可确认边界

### 3.1 Codex

OpenAI 已公开 Codex Credits 的按模型费率。当前官方表为：

| 模型 | 输入 Credits/百万 Token | 缓存输入 | 输出 |
|---|---:|---:|---:|
| GPT-5.6 Sol | 125 | 12.5 | 750 |
| GPT-5.6 Terra | 62.5 | 6.25 | 375 |
| GPT-5.6 Luna | 25 | 2.5 | 150 |
| GPT-5.5 | 125 | 12.5 | 750 |
| GPT-5.4 | 62.5 | 6.25 | 375 |
| GPT-5.4 mini | 18.75 | 1.875 | 113 |

来源：[OpenAI Codex Pricing](https://developers.openai.com/codex/pricing)。

因此，同样 100 万输入 Token，Sol 的 Credits 是 Luna 的 5 倍。三个模型不能仅按原始 Token 比例归因。

Fast 的额度倍率也不是速度提升倍率。当前官方明确列出的消耗倍率是：

- GPT-5.5 Fast：标准模式的 2.5 倍 Credits。
- GPT-5.4 Fast：标准模式的 2 倍 Credits。

“速度提升 1.5 倍”不能当作“额度消耗 1.5 倍”。来源：[OpenAI Codex Speed](https://learn.chatgpt.com/docs/agent-configuration/speed)。

OpenAI 公开资料确认本地消息与云任务共享 5 小时限制，并可能存在附加周限制。本项目本次仍使用服务端已经取得的母号 5 小时和周快照作为总量真相源，不在本地猜测不同套餐的窗口总容量。

### 3.2 Claude

Anthropic 公开说明订阅用量受模型、上下文长度、缓存、工具和 effort 等因素影响，付费套餐具有 5 小时 session 窗口以及周限制，但没有公开消费者订阅额度内部的完整换算公式。

来源：[Claude Usage Limit Best Practices](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)、[Claude Pro Plan](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan)。

Anthropic 公布了模型 Token 价格。本项目用它作为绑定用户之间的相对 CU 权重，但不会把 API 美元价格宣称为 Claude 订阅额度的精确内部算法。母号 `/api/oauth/usage` 返回的 `five_hour` 和 `seven_day` 仍是最终总量真相源。

当前相关官方价格：

| 模型 | 输入/百万 | 缓存读取 | 输出/百万 |
|---|---:|---:|---:|
| Claude Fable 5 | $10 | $1 | $50 |
| Claude Opus 4.8/4.7/4.6/4.5 | $5 | $0.5 | $25 |
| Claude Sonnet 5（截至 2026-08-31） | $2 | $0.2 | $10 |
| Claude Sonnet 5（自 2026-09-01） | $3 | $0.3 | $15 |
| Claude Sonnet 4.6/4.5 | $3 | $0.3 | $15 |
| Claude Haiku 4.5 | $1 | $0.1 | $5 |

缓存写入 5 分钟和 1 小时的官方价格分别通常为基础输入的 1.25 倍和 2 倍。来源：[Anthropic Pricing](https://docs.claude.com/en/docs/about-claude/pricing)。

## 4. 方案选择

考虑过三种方案：

### 方案 A：只按母号 delta 分配

优点是实现最少。缺点是仍受 delta 到达顺序影响，无法公平区分 Sol、Luna、Fable 等模型，不能解决本次根因。

### 方案 B：只按官方 CU 扣固定额度

优点是每次请求都能立即得出确定消耗。缺点是不同套餐实际容量、官方修正、缓存策略和未公开规则无法完全复刻，用户血条会逐渐偏离母号真实剩余。

### 方案 C：官方 CU + 母号快照校准

这是本次选定方案。

- CU 决定用户之间怎样公平分配。
- 母号快照决定总共实际消耗了多少。
- 当前窗口累计重算消除 per-delta 清空造成的时序误差。
- Codex 使用官方 Credits 表。
- Claude 使用官方价格作为相对权重，并由真实母号快照持续校准总量。

## 5. 核心数据模型

### 5.1 两个窗口，不拆模型池

每个母号只维护两套公平分配状态：

```text
account
├── primary：5 小时窗口
└── weekly：周窗口
```

一次有效请求计算出一个 CU，并同时累计到当前 5 小时和周窗口。两个窗口有各自的：

- `windowStart`
- `resetAt`
- `lastFraction`
- `lastSnapshotAt`
- `perCardCumulativeCu`
- `attributedShare`
- `unattributedShare`

模型不是窗口维度。模型只参与 `requestCU` 的计算。

### 5.2 标准用量事件

请求完成并通过现有 exactly-once 去重后，归一化成：

```ts
interface FairShareUsageEvent {
  provider: "codex" | "anthropic";
  accountId: number;
  cardId: string;
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  serviceTier: "standard" | "fast";
  occurredAt: number;
  rateVersion: string;
}
```

Codex 没有缓存写入字段时，两种 cache write 均为零。Claude 若上游只给缓存创建总量而没有 5 分钟/1 小时拆分，第一版统一按 5 分钟缓存写入计算，并记录 `cacheWriteResolution="assumed-5m"` 供排障；不得静默当普通输入计算。

### 5.3 模型费率注册表

模型费率从公平分配器中拆出，使用明确、可测试、带生效时间的注册表：

```ts
interface ModelRate {
  provider: "codex" | "anthropic";
  canonicalModelId: string;
  aliases: string[];
  effectiveFrom: string;
  effectiveUntil?: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheWrite5mPerMillion?: number;
  cacheWrite1hPerMillion?: number;
  outputPerMillion: number;
  fastMultiplier?: number;
  version: string;
}
```

匹配顺序：

1. 上游响应中的真实 `response.model`。
2. 请求最终实际发送的模型。
3. 精确别名表。
4. 未识别模型进入 `unknown` 路径。

不得继续使用“不是 Gemini/GPT 就默认 Claude”作为主要分类规则。未识别模型不阻断正常请求，但使用该 provider 当前最高的已知保守费率，并记录结构化告警；后续补充映射后只影响新事件，不改写已经产生的当前窗口 CU。

现有 `recordUsage()` 对 `tab_*`、`flash_lite`、autocomplete 的无条件跳过必须删除。这些模型只要返回非零 usage 就进入统一 CU 计算；如果未来取得官方“不消耗额度”的明确证据，再通过费率注册表给具体模型配置零倍率，而不是在公平分配器里按名称硬编码跳过。

## 6. CU 计算

### 6.1 通用公式

```text
requestCU =
  inputTokens × inputRate
  + cachedInputTokens × cachedInputRate
  + cacheWrite5mTokens × cacheWrite5mRate
  + cacheWrite1hTokens × cacheWrite1hRate
  + outputTokens × outputRate
```

费率统一除以一百万不会影响用户占比，可保留官方单位直接计算，也可使用等比例缩放后的整数单位，前提是同一 provider 内始终一致。

### 6.2 Codex Fast

Fast 倍率按“模型 + 生效时间”读取，不能使用全局常量：

```text
finalCU = requestCU × fastMultiplier(modelId, occurredAt)
```

当前明确支持的 GPT-5.5 与 GPT-5.4 分别使用 2.5 和 2。没有官方费率的模型不得因为 `service_tier=priority` 就默认乘 1.5。

### 6.3 Claude

Claude 的 CU 表示官方价格等价单位，仅用于同一母号绑定用户之间的相对分摊。母号实际消耗仍以 `five_hour`/`seven_day` 快照为准，所以即使 Anthropic 订阅内部算法与 API 价格不完全一致，总体血条也不会脱离母号真实水位；误差只可能影响不同模型用户之间的相对分配。

## 7. 当前窗口累计与实时重算

### 7.1 请求到达

每次请求完成后：

```text
CU_i ← CU_i + requestCU
```

`CU_i` 在当前官方窗口 reset 前不清空。

如果窗口已经存在可归因的母号消耗，则 CU 比例变化后立即重算：

```text
T_i = assignedBurn × CU_i / ΣCU
```

其中：

- `CU_i`：某卡当前窗口累计 CU。
- `assignedBurn`：当前已确认、可分配给 GFA 绑定用户的母号消耗比例。
- `T_i`：该卡当前承担的母号消耗比例。

### 7.2 母号快照下降

对可信快照：

```text
burnDelta = previousFraction - nextFraction
```

当 `burnDelta > 0`：

- 当前窗口 `ΣCU > 0`：增加 `assignedBurn`，按整个窗口累计 CU 重算所有卡。
- 当前窗口 `ΣCU = 0`：增加 `unattributedShare`，不把这段消耗留给后来出现的用户。

不再执行 `perCard.clear()`。

### 7.3 母号快照上升

用户已明确要求母号上涨时用户也应上涨。因此在快照通过顺序和窗口校验后，当前模式不再等待 5 分钟低水位确认，而是立即处理：

```text
recovery = nextFraction - previousFraction
```

恢复量在 `assignedBurn` 与 `unattributedShare` 之间按当前占比分摊减少，再按累计 CU 重算 `T_i`。这样保持：

```text
ΣT_i + unattributedShare ≤ 母号当前已确认消耗
```

结果是母号真实水位抖动时，用户血条也可能跟随小幅变化。这是“每次可信变化都重算”的预期行为，不再额外平滑。

### 7.4 冷启动

服务端在窗口中途第一次见到母号快照时，只把当前 fraction 采纳为基线，不把此前已经发生、但缺少本地 CU 证据的母号消耗砸给当前在线用户。

如果当前窗口状态已经从 `FairShareWindow` 成功恢复，则继续使用持久化的 `assignedBurn`、累计 CU 和快照时间，不重新冷启动。

## 8. 快照可信性

每个快照必须携带或在服务端补齐：

```ts
interface QuotaSnapshot {
  provider: "codex" | "anthropic";
  accountId: number;
  scope: "primary" | "weekly";
  remainingFraction: number;
  resetAt: number;
  observedAt: number;
}
```

接受条件：

- `accountId` 必须来自已验证 lease，不信任客户端任意填写。
- `remainingFraction` 必须有限且在 `[0,1]`；`-1` 只代表未知，不参与重算。
- `observedAt` 必须晚于该窗口最后接受的快照。
- `resetAt` 必须属于当前窗口，或明确推进到下一个窗口。
- 同一窗口内 `resetAt` 的小幅漂移继续使用现有容差，不因漂移清空状态。
- 已结束窗口或旧账号的快照不能覆盖当前状态。

Codex 优先使用客户端已经获取的 `fetchedAt`。Claude 服务端主动轮询时使用请求完成时间。旧客户端没有采集时间时，可暂用服务端接收时间，但标记 `timestampSource="server-received"` 以便观察。

## 9. reset 行为

只有以下情况允许清空当前窗口累计 CU：

1. 上游 `resetAt` 明确推进到新窗口。
2. 当前窗口已经过期，且没有更可信的上游窗口信息。

reset 操作：

```text
清空 perCardCumulativeCu
清空 attributedShare
清空 unattributedShare
更新 windowStart/resetAt
采纳新窗口首个可信 fraction
重新锁定当前窗口参与份额
```

普通轮询、fraction 下降、fraction 上升和模型切换都不得清空累计 CU。

## 10. 血条与拦截

界面继续展示两根独立血条：

- 5h 血条读取 `primary` 的个人剩余。
- 周血条读取 `weekly` 的个人剩余。

不计算“两个窗口最低值”作为第三个合成血条。

本次不改变现有售卖份额 `e_i`、锁定分母和窗口内新卡预留规则，只替换每卡归因 `T_i` 的计算来源。单窗口个人裸剩余仍为：

```text
personalRemaining = max(0, e_i - T_i) / e_i
```

拼车卡继续使用现有账号余量缩放，保证所有人的可用剩余合计不超过母号真实剩余；独享卡继续沿用现有独享展示语义。这样模型 CU 改造不会顺带改变套餐份额和超卖策略。

请求准入规则保持简单：

```text
primary 个人剩余 > 0
且 weekly 个人剩余 > 0
→ 允许
```

任一窗口耗尽时，返回该窗口自己的 `resetAt` 和原因，客户端可以准确告诉用户等 5 小时窗口还是周窗口恢复。

## 11. 持久化：不建历史窗口表

### 11.1 当前热状态

继续使用 `FairShareWindow` 保存当前窗口。字段语义调整为：

- `weightedUsed`：当前窗口该卡累计 CU，不再是“自上次 delta 以来的 CU”。
- `attributedShare`：当前按累计 CU 重算后的 `T_i`，允许上升或下降。
- `lastFraction`：最后接受的可信 fraction，不再是永久低水位。
- 新增 `lastSnapshotAt`：拒绝旧快照倒灌。
- 新增 `unattributedShare`：保存无法归因给本地用户的母号消耗。
- 新增 `algorithm`：识别当前状态使用的归因算法版本。窗口内可能混合多个模型费率版本，因此热表不保存一个会误导人的单一 `rateVersion`；已经累计的 CU 本身就是跨版本恢复所需的权威值。

同一个账号的 `lastSnapshotAt`、`unattributedShare` 等窗口标量沿用当前模式，重复写在该账号窗口的各卡行中。序列化时从同一个内存 tracker 生成全部行；加载时要求同组标量一致，不一致时拒绝恢复该组并按冷启动处理。本次不新增窗口头表，也不新增历史归档表。

### 11.2 排障数据

当前代码没有完整的 per-request 永久账本。`CardUsageHourly` 是按小时、卡、账号、模型聚合的尽力写入数据，flush 失败时可能丢失。因此本方案明确：

- 它可以用于核对模型、Token 和 CU 趋势。
- 它可以支持近似复算和线上对比。
- 它不是额度执行的权威数据。
- 它不能保证关闭窗口的精确回滚。

为提高排障能力，小时聚合增加：

- `weightedCu`
- `rateVersion`
- `standardCu`
- `fastCu`

这些字段不参与实时拦截。实时拦截只读取 `FairShareWindow` 的当前热状态。

### 11.3 reset 后数据

窗口 reset 后直接覆盖/清理 `FairShareWindow` 当前行，不归档旧窗口。不提供“一键恢复上一窗口”。如果未来实际运营证明必须做精确审计，再单独设计强一致用量账本，而不是把复杂历史逻辑塞回本次修复。

## 12. 现有代码与新方案的差异

| 场景 | 当前实现 | 新实现 |
|---|---|---|
| Codex 模型 | 全部使用相同 GPT 权重 | 使用官方逐模型 Credits |
| Codex 输出倍率 | 输入的 8 倍 | 官方当前多数模型约 6 倍 |
| Fast | 统一 1.5 倍 | 按模型官方额度倍率 |
| Claude | 按大类价格，缺少有效期 | 精确模型 + 生效时间 + 缓存写入 |
| 母号下降 | 分配 delta 后清空 perCard | 保留窗口累计 CU，重算全部用户 |
| 母号上涨 | 延迟确认后退款 | 可信快照立即重算上涨 |
| 轮询频率 | 会改变分段边界与结果 | 不清累计 CU，结果显著降低对轮询时机的依赖 |
| 模型切换 | 可能同权或误分类 | 每个请求按真实模型计算 CU |
| reset | 清当前状态 | 仍清当前状态，不保存历史表 |

## 13. 代码边界

建议新增：

- `apps/server/src/leasing/quota/model-rate-registry.ts`：模型精确映射、费率版本与生效时间。
- `apps/server/src/leasing/quota/fair-share-cu.ts`：纯函数 CU 计算，不读取数据库或快照。

建议修改：

- `packages/shared/src/pricing.json`：从 family 均价升级为明确模型费率，或只保留展示价格并把额度费率迁到 registry。
- `apps/server/src/leasing/lease-core/product-bucket.ts`：移除未知模型默认 Claude 的额度归类行为。
- `apps/server/src/leasing/token-server/fair-share-tracker.ts`：加入累计窗口重算模式和快照时间校验。
- `apps/server/src/leasing/lease-core/lease-service.ts`：请求完成后记录模型 CU，再同步母号快照。
- `apps/server/src/leasing/token-server/token-usage-tracker.ts`：小时聚合写入 CU 与费率版本。
- `apps/app/claude_sse.go`：完整保留缓存读取与缓存创建信息；能取得 5m/1h 明细时分别上报。
- `apps/app/codex_proxy.go`、`apps/app/codex_ws.go`：继续以上游响应实际模型和 usage 为准，并携带快照采集时间。
- `prisma/schema.prisma`：只扩展当前热表与小时聚合，不新增历史窗口表。

## 14. 兼容与上线

保留 provider 级算法开关：

```text
BCAI_CODEX_FAIR_SHARE_ALGO=segment-v1|window-cu-v1
BCAI_ANTHROPIC_FAIR_SHARE_ALGO=segment-v1|window-cu-v1
```

上线顺序：

1. 部署模型费率注册表和 CU 影子计算，不改变拦截结果。
2. 同时记录旧算法与新算法的个人剩余差异。
3. 验证 Sol/Terra/Luna、Fast、Fable/Opus/Sonnet/Haiku 的 CU 与官方表一致。
4. 验证快照乱序、上涨、下降和 reset 行为。
5. 先开启 Codex `window-cu-v1`。
6. 观察至少一个完整 5 小时窗口及一次母号上涨/修正。
7. 再开启 Anthropic。
8. 旧算法保留一个发布周期，稳定后删除。

不需要客户端 UI 大改。客户端继续接收和显示 5h、周两根血条；主要变化在服务端计算和快照可信性。

## 15. 测试要求

### 15.1 模型 CU

- Sol、Terra、Luna 同样 Token 得出 5:2.5:1 的输入 Credits 比例。
- Codex 缓存输入按各模型输入的 0.1 计算。
- Codex 输出按官方表计算，不再统一 ×8。
- GPT-5.5 Fast ×2.5、GPT-5.4 Fast ×2。
- Fable 5 相对 Opus 4.8 为 2 倍。
- Sonnet 5 在 2026-08-31 与 2026-09-01 两侧使用不同费率版本。
- 未识别模型走 provider 保守费率并产生告警，不误归到 Claude。
- 自动补全及其他辅助模型返回非零 usage 时正常计入，不允许无条件跳过。
- 请求失败且 usage 为零时不产生 CU；失败但上游返回非零 usage 时仍按真实 usage 计入。

### 15.2 归因时序

- A 大请求后母号分两次下降，B 在两次下降之间发小请求；B 不承担全部第二段下降。
- 轮询一次报告 40% 下降与分四次报告 10% 下降，最终归因近似一致。
- 新用户加入后，已分配总消耗保持不变，只按最新累计 CU 比例重新分布。
- 没有本地 CU 时发生的母号下降进入 `unattributedShare`，后来用户不继承。

### 15.3 上涨与快照

- 同一窗口 fraction 上升后，各卡归因立即下降。
- 旧 `observedAt` 快照不能覆盖新状态。
- 其他账号快照不能修改当前 lease 账号。
- `resetAt` 小幅漂移不清窗口。
- 真 reset 只清对应的 5h 或周窗口，另一个窗口不受影响。

### 15.4 持久化

- 重启后恢复累计 CU、当前归因、最后 fraction 和快照时间。
- reset 后不产生历史窗口行。
- 小时聚合 CU 丢失或延迟不能影响实时额度执行。

## 16. 已知限制

1. 母号同时被 GFA 外部客户端使用时，仅靠母号 fraction 和本地 CU 无法精确判断外部消耗属于谁。无本地 CU 时可记为未归因；与本地请求交错时只能按当前累计比例近似分配。
2. Claude 没有公开订阅额度的完整内部公式，官方 API 价格只是相对权重。母号快照保证总量正确，但不同模型用户之间仍可能存在小幅相对误差。
3. 去掉历史窗口表后，关闭窗口不能精确回滚。这是本次主动接受的复杂度取舍。
4. 每次可信变化都重算意味着母号水位真实抖动时用户血条也会跟随变化；本次不增加额外平滑。

## 17. 验收标准

- Codex 使用官方逐模型 Credits，而不是统一 GPT 权重。
- Claude 使用带有效期的官方模型相对价格。
- 所有返回非零上游 usage 的模型请求都计入 CU，模型之间仅倍率不同。
- 每次请求累计 CU，普通快照变化不清空窗口累计用量。
- 母号可信下降和上涨都会立即重算用户额度。
- 5h 和周窗口完全独立，不按模型拆池，不合成最低血条。
- 只有官方 reset 清理对应窗口。
- 不新增历史窗口表。
- 乱序和跨账号快照不能污染当前状态。
- 可以通过环境变量分别回退 Codex 或 Anthropic 到旧算法。
