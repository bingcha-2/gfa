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

### 4.1 不回归边界：超卖、独享与套餐份额

本次不是套餐、席位或销售策略改造。以下现有语义必须保持不变：

- 卡权重 `w_i` 的来源与计算方式不变。
- 母号保底席位数 `N` 不变。
- 份额分母继续使用 `D = max(N, Σw)`。
- 超卖订单是否允许创建、绑定账号选择、超卖后份额切薄规则不变。
- `exclusive` 显式标记、满权重自动识别独享、客户端独享徽标不变。
- 独享血条是否跳过拼车 scale 的现有产品语义不变。
- 中途加绑调用 `refreshParticipants()` 后即时重算 `D` 的现有语义不变。
- 5h 和周窗口各自锁定参与者与 reset 的行为不变。

允许改变的只有：

- 原始 Token 如何按真实模型换算成 CU。
- `weightedUsed` 从段内增量改为当前窗口累计 CU。
- 母号可信变化后 `T_i` 如何按窗口累计 CU 重算。
- 快照时序校验与当前窗口持久化可靠性。

任何导致 `w_i`、`N`、`D`、`e_i`、独享判定、超卖订单结果或徽标发生变化的代码，都视为本次范围外回归，必须阻止合并，不能通过修改旧测试期望来掩盖。

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
- `unattributedRefundDebt`(回血欠账,见 7.2/7.3)

模型不是窗口维度。模型只参与 `requestCU` 的计算。

### 5.2 标准用量事件

请求完成并通过现有 exactly-once 去重后，归一化成：

```ts
interface FairShareUsageEvent {
  reportId: string;
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
  requestStartedAt: number;
  upstreamCompletedAt: number;
  arrivedAt: number;
  rateVersion: string;
}
```

`requestStartedAt` 和 `upstreamCompletedAt` 使用客户端记录的上游请求时刻，`arrivedAt` 只表示服务端收到上报的时刻。归因排序使用 `upstreamCompletedAt`，不能使用 `arrivedAt`，否则快照先到、上报后到时仍会得到不同结果。客户端时钟明显漂移时，以该 lease 的服务端签发时间和接收时间夹住并标记 `clock-clamped`；不得把异常时间写到其他窗口。

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

### 6.4 API 等价价值与额度 CU 必须分离

“额度 CU”和“官方 API 等价价值 USD”是两个不同概念：

- CU 用于在共享母号内分配 5h/周消耗。
- USD 只用于看板估算“同样 Token 按官方 API 价价值多少”。
- 订阅实际成本不等于 API 价，所以 UI 不再把它无条件称为“已节省金额”。

两者可以引用相同模型 id 和生效日期，但必须使用不同注册表、不同类型和不同函数，禁止再次从一个 family 均价同时派生额度与金额。

当前 OpenAI Standard 短上下文官方 API 价为：

| 模型 | 输入 $/M | 缓存读 | 缓存写 | 输出 |
|---|---:|---:|---:|---:|
| GPT-5.6 Sol | 5.00 | 0.50 | 6.25 | 30.00 |
| GPT-5.6 Terra | 2.50 | 0.25 | 3.125 | 15.00 |
| GPT-5.6 Luna | 1.00 | 0.10 | 1.25 | 6.00 |
| GPT-5.5 | 5.00 | 0.50 | — | 30.00 |
| GPT-5.4 | 2.50 | 0.25 | — | 15.00 |
| GPT-5.4 mini | 0.75 | 0.075 | — | 4.50 |

GPT-5.6、GPT-5.5 和 GPT-5.4 系列还可能有 long-context 价格。`api-pricing.json` 为每个模型和生效区间保存官方 `contextThreshold`；当前相关官方表使用 272K 上下文分界，但不能把它永久写死成所有模型的全局常量。价格档必须在单次请求产生时确定，不能把一小时或一天 Token 聚合后再用平均值猜档位。

Fast 使用官方 Priority 价格，不使用统一倍率。当前相关 Priority 短上下文价包括：

| 模型 | 输入 $/M | 缓存读 | 缓存写 | 输出 |
|---|---:|---:|---:|---:|
| GPT-5.6 Sol | 10.00 | 1.00 | 12.50 | 60.00 |
| GPT-5.6 Terra | 5.00 | 0.50 | 6.25 | 30.00 |
| GPT-5.6 Luna | 2.00 | 0.20 | 2.50 | 12.00 |
| GPT-5.5 | 12.50 | 1.25 | — | 75.00 |
| GPT-5.4 | 5.00 | 0.50 | — | 30.00 |
| GPT-5.4 mini | 1.50 | 0.15 | — | 9.00 |

来源：[OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)。Claude API 价值继续使用 [Anthropic Pricing](https://docs.claude.com/en/docs/about-claude/pricing) 的具体模型、缓存写入 TTL 和生效日期。

### 6.5 USD 单请求计算与聚合

每次请求在仍有完整 usage 维度时计算：

```text
apiValueUSD =
  inputTokens × inputUSD
  + cachedInputTokens × cacheReadUSD
  + cacheWrite5mTokens × cacheWrite5mUSD
  + cacheWrite1hTokens × cacheWrite1hUSD
  + outputTokens × outputUSD
```

同时保存：

- `apiPricingVersion`
- `apiPricingMode=standard|priority`
- `contextTier=short|long|unknown`
- `valuationQuality=exact|recalculated|legacy`
- `apiValueUSD`

`CardUsageHourly` 和客户端日/小时统计只累加已经按单请求算好的 USD，不能再从聚合后的 family Token 反推金额。这样 mixed model、mixed Fast、mixed short/long context 同处一小时也不会算错。

用户提供的 Sol 示例在全部属于 Standard 短上下文时应为：

```text
593.41K × $5/M
+ 24.47M × $0.50/M
+ 102.56K × $30/M
= $18.27885
```

当前显示 `$4.83`，可以反推出旧代码错误套用了 GPT family 统一价 `$1.25/$0.125/$10`。该示例作为客户端与服务端共同 golden test；若部分单次请求实际属于 long context，逐请求正确总值应高于短上下文基线。

### 6.6 历史累计金额迁移

客户端 `usage_stats.json` 和服务端 `CardUsageHourly` 中已累加的旧 USD 不能假装精确：

- 有模型、输入、输出、缓存拆分且无 Fast/long-context 歧义的旧记录：按请求日期对应的模型 Standard 短上下文费率重算，标记 `recalculated`。
- 只有小时/日模型聚合、无法判断单次 long-context 的旧记录：按 short-context 重算并显示“短上下文假设”。
- 旧 Fast 记录只有 `fastTokens` 总量、没有输入/输出/缓存拆分时：保留为 `legacy`，不能把总量强乘一个倍率冒充精确。
- 缺少真实模型的旧记录：使用当时 family 估算并标记 `legacy`，不混入“精确价值”而不加说明。
- 新版本上线后的请求全部保存 exact 单请求 USD。

客户端启动迁移只执行一次，写入 `apiPricingMigrationVersion`，并保留原文件备份直到新文件原子落盘成功。服务端历史行使用可重复执行的 migration/backfill；重复运行结果必须相同。

UI 调整为：

- “今日官方 API 价值”改为“今日 API 等价价值”。
- “累计 API 价值 · 已节省”改为“累计 API 等价价值”。
- tooltip 解释 Standard/Priority、short/long 和估算质量。
- 混有 `legacy` 数据时显示“含旧版估算”，不得只显示一个看似精确的美元数字。

## 7. 当前窗口累计与实时重算

### 7.1 请求到达

每次请求完成后：

```text
CU_i ← CU_i + requestCU
```

`CU_i` 在当前官方窗口 reset 前不清空。

请求到达时先按 `upstreamCompletedAt` 写入当前 5h/周窗口的因果分段。如果它属于最后快照之后的开放段，只累计 CU，不立即重新分配已经确认的旧消耗；如果它属于一个已经关闭的快照段，说明这是晚到上报，必须从该段开始重放后续分段并立即修正归因。

正常顺序下，只有母号出现新的可信 fraction 变化时，才使用截至该快照 `observedAt` 已发生的窗口累计 CU 重新计算：

```text
T_i = assignedBurn × CU_i / ΣCU
```

其中：

- `CU_i`：某卡当前窗口累计 CU。
- `assignedBurn`：当前已确认、可分配给 GFA 绑定用户的母号消耗比例。
- `T_i`：该卡当前承担的母号消耗比例。

如果请求完成后母号快照尚未更新，个人归因暂时保持上一次可信结果；新快照到达后一次性追平。反过来，如果快照先到而用量上报在支持的乱序期限内到达，晚到上报会插回它真实发生的分段并重放，最终结果必须与“上报先到、快照后到”完全一致。

### 7.2 母号快照下降

对可信快照：

```text
burnDelta = previousFraction - nextFraction
```

当 `burnDelta > 0`：

- 当前窗口 `ΣCU > 0`：增加 `assignedBurn`，按整个窗口累计 CU 重算所有卡。
- 当前窗口 `ΣCU = 0`：该段暂记 `unattributedShare`；若之后收到 `upstreamCompletedAt <= snapshot.observedAt` 的晚到上报，重放会自动把该段从无主账搬回真实用户。只有上报始终没有到达，才保持无主账。

不再执行 `perCard.clear()`。

### 7.2.1 快照先到、上报后到

每个已接受的 fraction 变化先在内存中关闭一个当前窗口因果段，至少保存：

```text
fromObservedAt / toObservedAt
beforeFraction / afterFraction
burnDelta / recovery
截至该段的 per-card cumulative CU
result revision
```

服务端对同一账号、同一 scope 按事件发生时间确定性重放：

1. 快照先到时立即更新母号总剩余并建立分段；不等待客户端，不阻塞账号血条。
2. 上报到达时用 `reportId` exactly-once 去重，再按 `upstreamCompletedAt` 找到所属分段。
3. 如果命中已经关闭的分段，从该段开始重算 `assignedBurn`、`unattributedShare` 和所有 `T_i`。
4. primary 与 weekly 分别重放，因为两者快照边界不同；同一 usage event 可以同时被两个当前窗口引用。
5. 重放后的新 revision checkpoint 成功后才向客户端确认上报成功。

已经没有乱序可能的连续前缀立即折叠进累计 CU、`assignedBurn` 和 `T_i`；checkpoint 只保存折叠后的当前状态与尚未对齐的短尾巴，不按请求永久保存事件行。相邻、同方向且没有成员变更的尾段允许合并。`REORDER_HORIZON_MS` 固定为 10 分钟，单窗口最多 128 段、序列化后最多 16 KB；任一上限到达时把最老且无法匹配的段折叠为确定的 `unattributedShare` 并记录 `USAGE_EVIDENCE_MISSING`。这样数据库规模由“账号数 × 两个当前窗口 × 卡数”决定，不随历史请求数线性增长。

因此，描述中的“几秒到几十秒”竞态可以确定性解决：usage report 在 10 分钟内到达时，网络到达顺序不影响最终归因。客户端正常重试必须在该期限内持续进行；超过期限或永久丢失的上报属于证据缺失，服务端只能保留 `unattributedShare`，不能在固定存储约束下无限等待或猜测某个用户。

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

## 10. 生命周期场景

### 10.1 服务首次启动或窗口中途冷建

如果数据库没有该母号当前窗口的可恢复状态，首个可信快照只建立基线：

- 采纳 `remainingFraction`、`resetAt` 和 `observedAt`。
- 不把冷启动前的母号消耗归给当前在线用户。
- 冷启动后所有非零 usage 正常累计。
- 从下一次可信 fraction 变化开始归因。

这会在缺失历史时短暂从宽，但不会出现“服务刚启动，第一个提问的人承担母号此前全部消耗”。

### 10.2 正常服务重启

正常关机必须完成当前窗口 checkpoint 后才能退出。启动流程必须：

1. 加载 `FairShareWindow`。
2. 校验同一账号窗口各行的 `windowStart`、`lastFraction`、`lastSnapshotAt`、`unattributedShare` 和算法版本一致。
3. 恢复累计 CU、归因、参与者与份额状态。
4. 处理已经真实过期的 5h/周窗口。
5. 完成以上步骤后才允许发放 lease。

恢复成功时，重启前后计算结果必须连续，不采用新的冷启动基线。

### 10.3 意外崩溃与未落盘窗口

当前实现主要依赖 30 秒定时 flush，意外崩溃可能丢失最近一段 CU 或快照。新实现不能把定时 flush 当作唯一正确性保障：

- 每次 exactly-once 用量上报完成 CU 累计后，必须把受影响母号的 primary 与 weekly revision 交给单体进程内唯一的 checkpoint 协调器。
- 每次接受可信母号快照并完成重算后，必须把对应窗口 revision 交给同一个协调器。
- 用量报告只有在关键 checkpoint 成功后才标记为已持久化完成；失败保持可重试状态。
- 定时 flush 继续保留，作为脏状态重试和兜底，不再承担唯一持久化责任。
- checkpoint 只覆盖当前账号受影响的两个窗口，不能继续每次删除重建整个 provider 的全部行。

本服务是单体进程，不引入外部消息队列，也不为此改 SQLite journal mode 或开启 WAL。所有额度持久化经过一个进程内单写协调器：

- 每个账号维护单调递增的内存 `revision`。
- 协调器使用最多 10 ms 的微批窗口；同一批最多 64 个账号 revision，任一条件到达立即提交。
- 同一账号连续变化只写批次内最新 revision；primary、weekly、report dedup 和紧凑会计摘要在同一事务中提交。
- 每个报告只有在 `persistedRevision >= itsRevision` 后才返回持久化成功。
- checkpoint 写入优先级最高；普通诊断日志只批量写，TTL 清理只在关键写队列为空时运行。
- exactly-once 去重状态与 checkpoint 的提交顺序必须保证：checkpoint 失败后的客户端重试不会被误判成“已经上报”而直接忽略。
- 禁止每个请求单独开启一个 checkpoint 事务，禁止每次删除重建整个 provider，禁止诊断日志与 checkpoint 各抢一次写锁。

10 ms 是落盘组批等待上限，不是额度刷新延迟：内存状态和响应中的血条立即重算；只有“上报已可靠接收”的确认等待包含自身 revision 的事务成功。

无法解决的边界是“上游请求已经消耗母号，但客户端在发送 usage report 前彻底崩溃”。这部分只能由后续母号 fraction 变化发现，并按无本地证据消耗处理。

### 10.4 母号已消耗后，新订阅半路加入

本次保留现有“中途加绑即时生效”的产品语义，但明确其会计规则：

1. primary 和 weekly 分别刷新当前在册参与者，按现有 `D = max(N, Σw)` 重新计算份额 `e_i`。
2. 不清空任何已有用户的累计 CU、`T_i`、母号 fraction 或窗口时间。
3. 新订阅初始 `CU_new = 0`、`T_new = 0`，不直接继承加入前已经归给其他用户的消耗。
4. 新订阅不是获得一份新的母号满额度；它的展示继续受母号当前真实剩余和账号余量缩放约束。
5. 新订阅产生第一笔 usage 时只累计 CU。等下一次可信母号 fraction 变化后，再参与整个窗口的 CU 比例重算。
6. 重新计算分母可能缩小老用户的 `e_i`；这是中途超卖即时生效的既有业务结果，不得通过清零老用户 `T_i` 来掩盖。

例如母号剩余 60%，A 已有累计 CU，B 此时加入：B 初始不承担 A 已经归因的消耗；B 发出请求后其 CU 被保留，但在母号仍是旧的 60% 快照时不搬动旧账。母号出现新的可信水位后，才按 A、B 截至该时点的累计 CU 重算。

### 10.5 订阅退出、续费与换卡

- 同一订阅正常续费且额度主体标识不变：保留当前窗口 CU 与归因。
- 订阅退出：立即失去请求资格，但它已经产生的 CU 和归因作为只读会计残留保留到对应窗口 reset，不能删除后把历史消耗转嫁给仍在线用户。
- 同一订阅仅更换访问凭证或卡号：必须转移或沿用稳定的额度主体标识，不能借换卡获得 `CU=0、T=0` 的新身份。
- 真正的新订阅：按 10.4 的半路加入规则处理。
- 从一个母号迁移到另一个母号：旧母号中的历史 CU/归因保留到 reset，新母号按半路加入处理，不跨母号搬运 fraction。

公平分配器内部改用稳定的 `quotaSubjectId` 作为 map key，优先取订阅 id；旧数据无法取得订阅 id 时才兼容回退当前 `cardId` 并记录告警。这样凭证轮换不会重置窗口用量。

## 11. 血条与拦截

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

## 12. 持久化：固定规模当前状态，不建历史窗口表

### 12.1 当前热状态

继续使用 `FairShareWindow` 保存当前窗口。字段语义调整为：

- `weightedUsed`：当前窗口该卡累计 CU，不再是“自上次 delta 以来的 CU”。
- `attributedShare`：当前按累计 CU 重算后的 `T_i`，允许上升或下降。
- `lastFraction`：最后接受的可信 fraction，不再是永久低水位。
- 新增 `lastSnapshotAt`：拒绝旧快照倒灌。
- 新增 `unattributedShare`：保存无法归因给本地用户的母号消耗。
- 新增 `reorderTail`：紧凑保存尚可能被晚到上报修正的因果尾段；已稳定部分立即折叠，不保存逐请求历史。
- 新增 `revision/persistedRevision`：支持单体进程内组提交和崩溃恢复。
- 新增 `algorithm`：识别当前状态使用的归因算法版本。窗口内可能混合多个模型费率版本，因此热表不保存一个会误导人的单一 `rateVersion`；已经累计的 CU 本身就是跨版本恢复所需的权威值。

为避免 `reorderTail` 在每张卡重复保存，新增固定基数的 `FairShareWindowHead`：每个 `provider × accountId × scope` 只有一行，保存 fraction、reset、revision、未归因量和紧凑尾段；现有 `FairShareWindow` 只保存逐卡 CU/T。两张表的行数都由当前账号和当前卡数决定，reset 后覆盖，不保留关闭窗口，不新增逐请求事件表。

### 12.2 排障数据

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

### 12.3 reset 后数据

窗口 reset 后直接覆盖/清理 `FairShareWindow` 当前行，不归档旧窗口。不提供“一键恢复上一窗口”。如果未来实际运营证明必须做精确审计，再单独设计强一致用量账本，而不是把复杂历史逻辑塞回本次修复。

## 13. 现有代码与新方案的差异

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

## 14. 代码边界

新增：

- `apps/server/src/leasing/quota/model-rate-registry.ts`：模型精确映射、费率版本与生效时间。
- `apps/server/src/leasing/quota/fair-share-cu.ts`：纯函数 CU 计算，不读取数据库或快照。
- `apps/server/src/leasing/quota/fair-share-window-repository.ts`：按账号保存当前窗口 revision，提供关键 checkpoint 和启动恢复。
- `apps/server/src/leasing/quota/quota-write-coordinator.ts`：单体进程内唯一写协调器，负责 10 ms/64 revision 微批、写入优先级和等待持久化水位。
- `apps/server/src/leasing/token-server/quota-diagnostic-tracker.ts`：紧凑诊断事件、队列上限、72h TTL 和行数封顶。
- `apps/server/src/leasing/rosetta/quota-diagnostics.service.ts`：按 trace/support code 查询、确定性 diagnosis 和脱敏导出。
- `apps/web/src/app/(console)/console/(dashboard)/(product)/quota-diagnostics/page.tsx`：管理员额度诊断搜索与时间线。
- `packages/shared/src/quota-rates.json`：Codex Credits 与 Claude 相对 CU 的独立版本化费率源。
- `packages/shared/src/api-pricing.json`：逐模型、逐模式、short/long、带生效日期的官方 API USD 费率源。

修改：

- `packages/shared/src/pricing.json`：降为旧 family 数据兼容读取，新金额不再使用；额度 registry 只读取 `quota-rates.json`，金额 registry 只读取 `api-pricing.json`。
- `scripts/sync-pricing.mjs`：同步 `api-pricing.json` 与 `quota-rates.json` 到 Go 客户端 embed 目录，并在 CI 校验同步后工作树无差异。
- `apps/server/src/leasing/lease-core/product-bucket.ts`：移除未知模型默认 Claude 的额度归类行为。
- `apps/server/src/leasing/token-server/fair-share-tracker.ts`：加入累计窗口重算模式和快照时间校验。
- `apps/server/src/leasing/lease-core/lease-service.ts`：请求完成后记录模型 CU，再同步母号快照。
- `apps/server/src/leasing/subscription/entitlement-sync.service.ts`：中途加入/退出时刷新份额，但保留窗口会计残留，并传递稳定 `quotaSubjectId`。
- `apps/server/src/leasing/token-server/token-usage-tracker.ts`：小时聚合写入 CU 与费率版本。
- `apps/server/src/leasing/token-server/request-log-tracker.ts`：扩展会计摘要，将实际 5 天保留改成 72h，并收紧 header/行数上限。
- `apps/server/src/leasing/token-server/account-quota-snapshot-tracker.ts`：补充 observedAt、接受结果、72h TTL 和行数上限。
- `apps/server/src/leasing/rosetta/rosetta.controller.ts`：增加管理员 quota diagnostics 查询与导出接口。
- `apps/app/claude_sse.go`：完整保留缓存读取与缓存创建信息；能取得 5m/1h 明细时分别上报。
- `apps/app/codex_proxy.go`、`apps/app/codex_ws.go`：继续以上游响应实际模型和 usage 为准，并携带快照采集时间。
- `apps/app/leaser_report.go`、`apps/app/codex_leaser.go`、`apps/app/claude_leaser.go`：贯穿 traceId/supportCode 与完整 usage 字段。
- `apps/app/pricing_price.go`：从 family 定价改为真实模型 + mode + context tier + 生效时间查询。
- `apps/app/usage_stats.go`：按单请求计算 USD、保存定价版本/质量并执行历史金额迁移；删除 Fast 统一 ×1.5。
- `apps/app/frontend/src/pages/DashboardPage.tsx`：金额文案改为 API 等价价值并展示估算质量。
- `apps/server/src/leasing/account/portal/portal.service.ts`：删除硬编码 `FAMILY_PRICING`，直接累计单请求持久化 USD。
- `apps/web/src/components/console/shell/console-sidebar.tsx`：增加“额度诊断”管理员入口。
- `prisma/schema.prisma`：增加固定基数 `FairShareWindowHead`，扩展逐卡热表、RequestLog、AccountQuotaSnapshot、小时聚合的 CU/USD/定价质量字段并增加 QuotaDiagnosticEvent；不新增历史窗口或逐请求额度事件表。

## 15. 兼容与上线

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

最终用户客户端 UI 不需要大改，继续显示 5h、周两根血条，并在额度错误中附 support code。管理员控制台新增额度诊断页面；主要计算变化仍在服务端。

## 16. 可观测性与三天诊断链

### 16.1 目标

线上出现“问两句额度没了”“过一会又涨回来”“reset 时间突然变了”时，管理员必须能在不重新开启 debug、不复现用户现场的前提下回答：

1. 哪个客户端、订阅、lease 和母号处理了请求。
2. 客户端请求模型与上游实际模型分别是什么。
3. 输入、缓存读取、缓存写入、输出和 Fast 各有多少。
4. 使用了哪个费率版本，算出多少 CU。
5. 请求前后用户累计 CU、`T_i`、份额 `e_i` 和血条是多少。
6. 母号 primary/weekly 快照来自哪里、何时采集、是否被接受。
7. 如果快照被拒绝，具体是旧时间、旧窗口、跨账号、非法 fraction 还是 resetAt 漂移。
8. 本次是否发生 reset、join、leave、rebind、cold start、restart recovery 或 checkpoint error。
9. 最终为什么允许或拦截请求。

诊断数据只能保存必要的计量元数据，不保存提示词、响应正文、工具输出、Authorization、Cookie、OAuth token、refresh token 或完整请求 body。

### 16.2 统一关联标识

每次推理请求建立一个 `traceId`，贯穿：

```text
Go 客户端代理
→ lease
→ 上游推理与 usage 解析
→ reportResult(reportId/leaseId)
→ CU 计算
→ 快照接受/拒绝
→ FairShare 重算
→ checkpoint
→ status/血条/拦截
```

规则：

- 新客户端生成随机、不可猜测的 `traceId`，只发送给 GFA 服务端，不转发到 OpenAI/Anthropic。
- `reportId` 继续负责 exactly-once 去重，`traceId` 负责诊断关联，两者不能混用。
- 服务端日志同时记录 `traceId`、`reportId`、`leaseId`、`accountId` 和稳定 `quotaSubjectId`。
- 旧客户端没有 `traceId` 时，服务端生成，并在 report/status 响应中返回。
- 上游安全请求 id 可以单独保存；不得保存含凭证的完整响应头。

### 16.3 一请求一条会计摘要

扩展 `RequestLog`，每个去重后的请求最多写一条紧凑会计摘要：

```ts
interface QuotaRequestDiagnostic {
  traceId: string;
  reportId: string;
  leaseId: string;
  provider: "codex" | "anthropic";
  accountId: number;
  accessKeyId: string;
  quotaSubjectId: string;
  requestedModel: string;
  actualModel: string;
  rateVersion: string;
  apiPricingVersion: string;
  apiPricingMode: "standard" | "priority";
  contextTier: "short" | "long" | "unknown";
  valuationQuality: "exact" | "recalculated" | "legacy";
  apiValueUSD: number;
  serviceTier: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  requestCu: number;
  primaryBeforeJson: string;
  primaryAfterJson: string;
  weeklyBeforeJson: string;
  weeklyAfterJson: string;
  decisionCode: string;
  checkpointRevision: number;
}
```

before/after JSON 只包含紧凑数值：`fraction/resetAt/observedAt/CU_i/ΣCU/T_i/e_i/unattributed/remaining`。每段最大 1 KB，超出即拒绝附加字段，不能无限截取大对象。

### 16.4 状态变化事件

新增 `QuotaDiagnosticEvent`，只记录真正改变或拒绝状态的事件，不为每次普通读取写日志：

```text
request_accounted
snapshot_applied
snapshot_rejected
window_reset
subscription_joined
subscription_left
subscription_rebound
account_rebound
cold_start_baseline
restart_recovered
checkpoint_failed
enforcement_denied
unknown_model_fallback
api_price_unknown
api_price_short_assumption
api_price_legacy
late_usage_reconciled
usage_evidence_missing
```

一条事件包含公共字段：

- `at`、`traceId`、`eventType`
- `provider`、`accountId`、`quotaSubjectId`
- `reportId`、`leaseId`
- `scope=primary|weekly|none`
- `reasonCode`
- `beforeJson`、`afterJson`、`detailJson`

索引：

- `[traceId, at]`
- `[reportId]`
- `[leaseId]`
- `[provider, accountId, at]`
- `[quotaSubjectId, at]`
- `[eventType, at]`
- `[at]`，供 TTL 清理

正常成功 checkpoint 不单独写事件，它的 revision 合并在请求/快照事件中；只有失败、重试和恢复写独立事件。这样避免一条请求膨胀成大量日志。

### 16.5 稳定 reason code

所有诊断原因使用稳定机器码，中文文案仅用于展示。至少包含：

```text
SNAPSHOT_STALE_OBSERVED_AT
SNAPSHOT_OLD_WINDOW
SNAPSHOT_ACCOUNT_MISMATCH
SNAPSHOT_INVALID_FRACTION
SNAPSHOT_UNKNOWN
RESET_ACCEPTED
RESET_DRIFT_IGNORED
USAGE_DUPLICATE_REPORT
USAGE_ZERO
MODEL_UNKNOWN_CONSERVATIVE_RATE
CACHE_WRITE_ASSUMED_5M
API_PRICE_UNKNOWN
API_PRICE_SHORT_ASSUMPTION
API_PRICE_LEGACY
LATE_USAGE_RECONCILED
USAGE_EVIDENCE_MISSING
COLD_START_BASELINE_ONLY
CHECKPOINT_FAILED
CHECKPOINT_RETRY_SUCCEEDED
DENY_PRIMARY_EXHAUSTED
DENY_WEEKLY_EXHAUSTED
DENY_NO_SHARE
SUBJECT_JOINED_MID_WINDOW
SUBJECT_LEFT_ACCOUNTING_RETAINED
SUBJECT_REBOUND_ACCOUNT_CHANGED
```

测试和运维查询依赖 reason code，不依赖可能变化的中文错误文本。

### 16.6 三天保留与容量保护

逐请求及额度诊断数据统一保留 72 小时：

| 数据 | 保留 | 硬上限 | 说明 |
|---|---:|---:|---|
| `RequestLog` | 72h | 200,000 行 | 当前代码实际为 5 天，改为 72h；header 上限从 8 KB 收紧到 2 KB |
| `QuotaDiagnosticEvent` | 72h | 150,000 行 | 状态变化事件；单个 JSON 字段 ≤4 KB |
| `AccountQuotaSnapshot` | 72h | 100,000 行 | 当前缺少清理，补 TTL 和行数上限 |
| 客户端/服务端 quota 结构化文件日志 | 72h | 单文件 100 MB、总量 500 MB | 按年龄与总量双重轮转，旧文件压缩 |

清理规则：

- 服务启动完成数据库连接后立即 prune 一次，然后每小时执行。
- 先按 `at/timestamp < now-72h` 分批删除，每批最多 500 行；每批提交后重新进入低优先级队列，先让出写入机会给 checkpoint。
- 再检查行数硬上限，超限时删除最旧数据；高流量期间允许实际保留少于 72 小时，优先保护数据库。
- 内存日志队列同样有上限；队列满时丢弃最旧诊断事件、增加 `diagnosticDropped` 计数并输出一次限频告警，不能拖垮请求主链。
- 清理失败记录 `DIAGNOSTIC_PRUNE_FAILED` 并重试，不能影响额度执行。
- 不为本功能开启 WAL 或增加额外 journal 运维。仅在低峰、关键写队列为空时执行 `PRAGMA optimize`；禁止请求高峰做阻塞式全库 `VACUUM`。

以下不是诊断日志，不受 72 小时 TTL 影响：

- `FairShareWindow`：当前未结束的权威执行状态，必须保留到对应官方 reset；周窗口可能超过 3 天。
- `CardUsageHourly`：低基数业务聚合，承担 30 天订阅退款/用量看板，继续使用现有 60 天保留。
- 订单、订阅、退款和封号事件：业务审计数据，沿用各自保留政策。

### 16.7 脱敏与安全

- 不记录请求/响应 body、prompt、代码内容和工具输出。
- 不记录 Authorization、Cookie、Set-Cookie、OAuth/refresh/access token。
- 请求头仍使用白名单，不再采用“过滤黑名单后全存”。
- IP 若诊断确需展示，默认存脱敏前缀或 HMAC；完整 IP 只沿用现有有权限的安全审计表，不复制进额度事件。
- `detailJson` 必须经过字段级 schema 序列化，禁止直接 `JSON.stringify(payload)`。
- 诊断 API 仅管理员可访问，所有查询记管理员审计日志。
- 导出的支持包再次脱敏，默认不含邮箱，只含 accountId/subjectId；管理员显式选择后才带邮箱。

### 16.8 诊断查询与支持包

新增管理员查询：

```text
GET /rosetta/quota-diagnostics/search
  ?traceId=
  &supportCode=
  &reportId=
  &leaseId=
  &accountId=
  &accountEmail=
  &accessKeyId=
  &quotaSubjectId=
  &from=
  &to=

GET /rosetta/quota-diagnostics/health
GET /rosetta/quota-diagnostics/:traceId
GET /rosetta/quota-diagnostics/:traceId/export
```

服务端从 `traceId` 生成短 `supportCode`，在额度拦截、额度异常响应以及客户端诊断日志中返回。用户只需要提供 support code，管理员即可反查完整 trace；support code 不能包含账号、邮箱或可推导的数据库 id。

详情按时间排序返回：

1. lease 和绑定关系。
2. 请求模型、实际模型、完整 Token/CU 公式。
3. primary/weekly 请求前后状态。
4. 同时段母号快照及接受/拒绝原因。
5. join/leave/rebind/reset/restart 事件。
6. checkpoint revision 与持久化结果。
7. 客户端最终收到的 fraction、resetAt 和拦截原因。

服务端生成 `diagnosis` 摘要，使用确定性规则标出：

- 旧快照倒灌尝试。
- 模型未知/费率保守回退。
- 客户端 usage 缺失或为零。
- 上游实际模型与请求模型不一致。
- 缓存写入精度降级。
- 中途加入/退出造成的份额变化。
- resetAt 漂移或真正 reset。
- checkpoint 延迟/失败。
- 母号存在无法归因消耗。

摘要只能根据已记录事实生成，不使用猜测性“可能是”覆盖原始时间线。原始事件和计算字段始终可下钻。

管理控制台增加“额度诊断”入口，支持按 support code、母号、订阅、卡、时间范围搜索，展示只读时间线和一键导出脱敏支持包。即使控制台页面不可用，管理员 API 仍可直接查询；诊断能力不能只存在于前端。

health 接口返回各诊断表行数、最老/最新时间、内存队列深度、累计 dropped、最近 flush/prune 成功时间和最近错误。查询不到 trace 时，界面必须区分“客户端从未上报”“已超过 72 小时”“日志队列曾溢出”和“筛选条件错误”，不能统一显示“无数据”。

### 16.9 可观测性测试

- 给定 `traceId` 能串起客户端、服务端请求、快照、重算、checkpoint 和血条结果。
- 每个稳定 reason code 至少一个测试。
- 任何模型的 CU 日志能够按记录字段重新算出同一结果。
- 旧/跨账号快照在诊断中可见为 rejected，且权威状态不变。
- 71h59m 数据保留，72h 以后删除。
- 超过行数上限删除最旧数据，不删除当前 `FairShareWindow`。
- 日志队列溢出不阻塞请求，并产生限频告警与 dropped 指标。
- 所有凭证、body 和 prompt 脱敏测试使用高风险哨兵字符串，数据库和导出包中均不得出现。
- 跨进程 E2E 失败时自动输出对应 trace 支持包，CI artifact 保留用于定位。

## 17. 测试要求

本次必须同时具备四层测试，不能只增加 `FairShareTracker` 单元测试：

1. 纯函数单测：模型映射、费率和 CU。
2. 服务端集成测试：真实 lease、report、订阅同步、持久化和血条接口。
3. 客户端集成测试：真实 Go 代理解析上游 SSE/响应头、生成 usage/quota report、消费服务端状态。
4. 客户端—服务端跨进程端到端测试：实际 Go 客户端和实际 Nest HTTP 服务串联，中间不替换额度业务逻辑。

### 17.1 模型 CU 与 API 等价价值

- Sol、Terra、Luna 同样 Token 得出 5:2.5:1 的输入 Credits 比例。
- Codex 缓存输入按各模型输入的 0.1 计算。
- Codex 输出按官方表计算，不再统一 ×8。
- GPT-5.5 Fast ×2.5、GPT-5.4 Fast ×2。
- Fable 5 相对 Opus 4.8 为 2 倍。
- Sonnet 5 在 2026-08-31 与 2026-09-01 两侧使用不同费率版本。
- 未识别模型走 provider 保守费率并产生告警，不误归到 Claude。
- 自动补全及其他辅助模型返回非零 usage 时正常计入，不允许无条件跳过。
- 请求失败且 usage 为零时不产生 CU；失败但上游返回非零 usage 时仍按真实 usage 计入。
- 客户端与服务端读取同一份 `api-pricing.json` golden fixtures，对每个模型得到完全相同 USD。
- Sol 示例 `593.41K input + 24.47M cache read + 102.56K output` 在 Standard short 下严格得到 `$18.27885`（界面四舍五入 `$18.28`），不能回到 `$4.83`。
- Terra、Luna、5.4 mini、Fable、Opus、Sonnet、Haiku 分别使用自身价格，不回退 family 均价。
- 同一模型 Standard short/long 与 Priority 官方已公布档位分别命中正确价格；当前 Priority 只公布 short，long 请求必须标记 `unsupported-context`，不得虚构 exact 价格。
- context tier 按单请求判定；把两个 short 请求聚合后超过 272K 不能误算成 long。
- Claude cache write 5m/1h 分别使用正确价格；只有总量时标记估算质量。
- 未知模型金额使用显式 fallback 并标记 `legacy/unknown`，不能悄悄显示为精确官方价。
- 历史迁移重复执行结果相同；原子写失败保留原文件，不能把累计数据清空。
- 本地今日、累计、逐模型金额与服务端 Portal 对同一事件序列完全一致。

### 17.2 归因时序

- A 大请求后母号分两次下降，B 在两次下降之间发小请求；B 不承担全部第二段下降。
- 轮询一次报告 40% 下降与分四次报告 10% 下降，最终归因近似一致。
- 新用户加入后不立即搬动旧归因；新的可信快照到达时，已分配总消耗按最新累计 CU 比例重新分布。
- 没有本地 CU 证据时发生的母号下降先进入 `unattributedShare`；发生时间晚于该快照的后来请求不继承。
- 窗口第一笔请求的快照先到、usage report 在 1 秒、30 秒、9 分 59 秒后到：晚到上报插回原段后，结果与 report 先到完全一致，无主账搬回请求用户。
- 窗口已有 A 的 CU，B 请求造成快照先下降、B report 后到：最终结果与 B report 先到完全一致，不能长期错扣 A。
- 同一组 usage/snapshot 事件随机打乱网络到达顺序，按事件时间重放后的 primary/weekly 状态逐字段一致。
- usage report 在 10 分钟后才到或永久未到时保持 `unattributedShare` 并记录 `USAGE_EVIDENCE_MISSING`，不能猜用户；尾段始终满足 128 段/16 KB 上限。
- 新订阅加入并产生 CU、但母号尚无新快照时，不得立即搬动已经确认的旧归因。

### 17.3 上涨与快照

- 同一窗口 fraction 上升后，各卡归因立即下降。
- 旧 `observedAt` 快照不能覆盖新状态。
- 其他账号快照不能修改当前 lease 账号。
- `resetAt` 小幅漂移不清窗口。
- 真 reset 只清对应的 5h 或周窗口，另一个窗口不受影响。

### 17.4 持久化与生命周期

- 重启后恢复累计 CU、当前归因、最后 fraction 和快照时间。
- 启动恢复完成前不发放 lease。
- 正常关机等待 checkpoint；意外崩溃恢复到最后一次成功的关键 checkpoint。
- 1、10、64、65 个并发 revision 验证 10 ms/64 条微批边界；每个报告必须等待覆盖自身 revision 的提交。
- 同一账号一批内多次变化只写最新 revision，两个窗口、dedup 和会计摘要原子提交。
- SQLite 保持项目现有 journal mode，不因本功能开启 WAL。
- 连续高并发上报同时触发 72h 清理：checkpoint 优先，清理每批不超过 500 行并在批间让出写入机会。
- 固定账号和卡数下连续运行大量请求，`FairShareWindowHead/FairShareWindow` 行数不随请求数增长。
- checkpoint 失败后重试不能被 exactly-once 去重错误忽略。
- 中途加入的新订阅从 CU/T 为零开始，但受母号真实剩余缩放。
- 退出订阅的历史 CU/T 保留到 reset，不转嫁给其他用户。
- 同一订阅换卡不重置额度主体。
- reset 后不产生历史窗口行。
- 小时聚合 CU 丢失或延迟不能影响实时额度执行。

### 17.5 超卖与独享回归套件

现有以下测试不能删除或放宽断言，只能补充 `window-cu-v1` 参数化用例：

- `apps/server/src/leasing/token-server/__tests__/fair-share-tracker.spec.ts`
- `apps/server/src/leasing/token-server/__tests__/fair-share-exclusive-weekly-coldstart.spec.ts`
- `apps/server/src/leasing/token-server/__tests__/fair-share-exclusive-load-selfheal.spec.ts`
- `apps/server/src/leasing/account/billing/__tests__/catalog-lifecycle-e2e.spec.ts`
- `apps/server/src/leasing/remote-codex/__tests__/codex-quota-e2e-weighting.spec.ts`

必须锁定：

- 未超卖、刚好满员、轻度超卖和严重超卖时 `D=max(N,Σw)` 不变。
- 任意序列 `Σe_i ≤ 1`。
- 拼车所有用户展示的账号级剩余合计不超过母号真实剩余。
- 独享卡继续按现有独享语义展示并在自身份额耗尽时拦截。
- 中途加入导致的份额切薄与当前生产语义一致。
- 新算法只改变 CU/T 归因，不改变订单、绑定、徽标和套餐权重。

### 17.6 服务端真实链路集成测试

在现有 Codex 场景套基础上增加 Anthropic 对称场景，并使用真实 Prisma 临时数据库、真实 `LeaseService`、`EntitlementSyncService` 和 HTTP controller：

- `leaseToken → reportResult → FairShareTracker → FairShareWindow → public status` 全链路。
- 用量 exactly-once 去重与关键 checkpoint 同时验证。
- 服务实例销毁、重新创建、`onModuleInit()` 恢复后结果一致。
- 订阅创建、加入、退出、续费、凭证更换和换母号走真实订阅同步入口，不直接修改 tracker 私有 Map。
- primary 与 weekly 分别 reset，不允许一个窗口清掉另一个。
- 旧算法开关和新算法开关在同一 fixture 下运行，除明确改变的 CU/T 外，其余业务输出一致。

新增：

- `apps/server/src/leasing/remote-codex/__tests__/codex-window-cu-lifecycle.e2e.spec.ts`
- `apps/server/src/leasing/remote-anthropic/__tests__/anthropic-window-cu-lifecycle.e2e.spec.ts`
- `apps/server/src/leasing/subscription/__tests__/fair-share-subscription-lifecycle.e2e.spec.ts`
- `apps/server/src/leasing/token-server/__tests__/fair-share-checkpoint-restart.e2e.spec.ts`

### 17.7 客户端—服务端跨进程 E2E Harness

新增一个独立黑盒测试入口，真实启动服务端并运行 Go 客户端测试：

```text
脚本 orchestrator
  ├── 创建临时 SQLite/账号/订阅数据
  ├── 启动真实 Nest HTTP 服务（随机端口）
  ├── 等待 health ready
  ├── 启动脚本化 OpenAI/Anthropic 假上游
  ├── 运行 apps/app 中的 Go E2E tests
  ├── 查询服务端公开 quota/status
  └── 关闭服务并检查无未落盘 revision
```

新增：

- `tests/quota-e2e/run.mjs`：跨进程编排、临时目录、端口和退出码管理。
- `tests/quota-e2e/server-fixture.ts`：以测试配置启动真实 Nest app；只替换外部 OpenAI/Anthropic 网络端点和可控时钟，不替换额度服务。
- `tests/quota-e2e/test-control.controller.ts`：仅测试构建启用，用于推进时钟、脚本化母号快照、触发优雅重启/异常退出和订阅生命周期动作；生产模块不得注册。
- `apps/app/quota_client_server_e2e_test.go`：实际 Codex/Claude leaser、proxy、usage parser、reporter、血条状态串联测试。

这套 E2E 必须验证真实 JSON/HTTP 契约，包括：

- Go 客户端以上游响应实际模型为准，而不是只用请求模型。
- 输入、缓存读取、缓存写入、输出、Fast 和 `observedAt` 完整上报。
- 服务端返回 primary/weekly 个人 fraction 和各自 resetAt。
- Go 客户端正确更新两根血条、倒计时和拦截原因。
- 服务端拒绝旧快照/跨账号快照后，客户端不能把它们重新显示出来。
- 旧客户端缺少 `observedAt`、缓存写入拆分或新模型字段时，新服务端走明确兼容降级且不记成零用量。
- 新客户端连接仍运行 `segment-v1` 的服务端时，新增字段可被忽略，旧链路不崩溃。
- 客户端今日/累计/逐模型 API 等价价值与服务端同事件结果逐分一致，并展示相同 pricing version/quality。

测试控制接口只负责制造外部事件，不得直接写 `FairShareTracker` 内存状态；所有状态变化必须经过与生产相同的 lease/report/subscription/quota snapshot 入口。

### 17.8 极限场景矩阵

以下场景 Codex 与 Anthropic 都要覆盖；仅某 provider 支持的模型字段可以单独标注：

#### 官方 reset 与 reset 时间变化

- primary 单独 reset，weekly 保持原窗口。
- weekly 单独 reset，primary 保持原窗口。
- 两个窗口同时 reset。
- fraction 从接近 0 跳回 1，`resetAt` 正确前移到下一窗口。
- fraction 上升但 `resetAt` 不变：按同窗口官方修正处理，不误清 CU。
- fraction 下降但 `resetAt` 小幅后移：按现有 drift 容差继续同窗口归因。
- `resetAt` 在容差内前后抖动，不 reset。
- `resetAt` 明确推进超过容差，只清对应窗口。
- 旧窗口快照晚到、`resetAt` 已过期、observedAt 更旧：全部拒绝。
- reset 与 usage report 同时发生：按 revision/observedAt 得出唯一确定结果，不重复计费、不丢 CU。

#### 用户中途加入

- 母号尚未消耗时加入。
- 母号已消耗 1%、50%、99% 时加入。
- 加入后未产生 usage：不承担旧归因。
- 加入后产生 usage、母号快照尚未变化：只累计 CU，不搬旧账。
- 加入后母号下降、上涨、reset：分别验证重算。
- 第 `N` 个用户刚好满员、第 `N+1` 个用户触发超卖切薄。
- 独享订阅所在母号中途出现新绑定时，既有独享标签/份额业务语义保持现状。

#### 用户中途退出与续费

- idle 用户退出。
- 已产生大量 CU/T 的用户退出：历史会计残留保留，不能转嫁。
- 退出与母号快照并发。
- 退出后同一订阅恢复：沿用同一 `quotaSubjectId`。
- 到期后续费：当前未 reset 窗口不能获得新额度。
- 退出用户跨 primary reset、weekly 未 reset：只清 primary 残留。

#### 用户订阅换号/换凭证

- 同一订阅只换 access key：CU/T 完全连续。
- 同一订阅换客户端设备：不产生新额度主体。
- 同一订阅从母号 A 迁到母号 B：A 保留会计残留，B 按半路加入。
- 换号时 A/B 的 resetAt 不同：分别遵循各自窗口。
- 换号与 usage report 同时发生：lease 所属账号决定唯一归属，不能双记或漏记。
- 旧 lease 在换号后迟到上报：仍归原 lease 账号，不能污染新账号。

#### 重启、故障与乱序

- usage 后、快照前正常重启。
- 快照重算后正常重启。
- checkpoint 写入过程中异常退出。
- checkpoint 失败后客户端重试相同 reportId。
- 服务端重启后收到重启前生成的旧快照。
- 同一 reportId 重复 2 次、100 次，最终只计一次。
- 100 个用户并发上报，同时穿插 fraction 上升、下降和 reset。
- 100 个用户并发上报期间启动 TTL 清理，验证无逐请求 checkpoint、无全 provider 重建、无明显写锁尖刺。
- 数据库同组窗口标量不一致：拒绝部分恢复并走明确冷启动，不拼接脏状态。

#### 数值极限与模型变化

- 0 Token、1 Token、超大 Token、输出远大于输入、全部缓存命中。
- Claude 5m/1h cache write 拆分与只能得到总 cache creation 的降级路径。
- Sol、Terra、Luna、Fable、Opus、Sonnet、Haiku、autocomplete 和未知模型混用。
- 模型费率生效时间恰好跨过窗口中点与 reset 边界。
- fraction 为 0、1、极小浮点、NaN、Infinity、-1 unknown。
- CU、T、fraction 永远不能产生 NaN、Infinity、负数或超过合法上界。

### 17.9 全局性质测试

除场景用例外，使用固定 seed 的属性/随机序列测试生成 usage、snapshot、join、leave、rebind、restart、reset 事件，持续验证：

```text
窗口内 CU_i 单调不减，只有对应 reset 清零
ΣT_i + unattributedShare 不超过已确认母号消耗
Σe_i ≤ 1
T_i ≥ 0
个人剩余在 [0,1]
旧 observedAt 不能改变状态
重复 reportId 不能改变状态
primary 操作不能清 weekly，weekly 操作不能清 primary
序列化→加载后状态等价
```

随机测试失败时必须打印 seed 和完整事件序列，保证 CI 中可以复现。

### 17.10 全量回归与 CI 门禁

额度改造合并前必须执行仓库全量回归，不允许只跑额度相关测试：

```bash
pnpm test
node tests/quota-e2e/run.mjs
```

`pnpm test` 已包含全仓 lint、单元测试、集成测试、现有 E2E 和全部 Go 测试。新增跨进程 quota E2E 应同时接入根 `test:e2e`，上方显式命令用于本地单独复跑；CI 中不得重复运行两遍。

必须回归的核心域至少包括：

- Codex/Claude lease、proxy、usage parsing、quota sync、429 和模型 gate。
- 所有 `FairShareTracker`、独享、超卖、冷启动、自愈和持久化用例。
- 订阅下单、绑定、到期、续费、退出、换绑和退款。
- 客户端血条、倒计时、5h/weekly 同步和本地拦截。
- 数据库 migration、旧数据 load、旧客户端兼容和旧算法回退。
- 本次新增的跨进程客户端—服务端 E2E 与属性测试。

任何失败必须先定位并修复；不得通过跳过测试、缩小测试集合、放宽断言或批量更新快照来取得绿色结果。

跨进程 E2E 不得设为默认跳过。若运行时间过长，可拆成每次 PR 的核心矩阵与 nightly 的 100 用户并发/随机长序列，但官方 reset、resetAt 漂移、中途加入/退出、换号、重启和客户端—服务端契约必须属于每次 PR 的必跑集合。

## 18. 已知限制

1. 母号同时被 GFA 外部客户端使用时，仅靠母号 fraction 和本地 CU 无法精确判断外部消耗属于谁。无本地 CU 时可记为未归因；与本地请求交错时只能按当前累计比例近似分配。
2. Claude 没有公开订阅额度的完整内部公式，官方 API 价格只是相对权重。母号快照保证总量正确，但不同模型用户之间仍可能存在小幅相对误差。
3. 去掉历史窗口表后，关闭窗口不能精确回滚。这是本次主动接受的复杂度取舍。
4. 每次可信变化都重算意味着母号水位真实抖动时用户血条也会跟随变化；本次不增加额外平滑。
5. 为保持单体 SQLite 数据规模固定，乱序重放只保证 10 分钟内的晚到上报；超过期限或永久缺失的凭证按无本地证据消耗处理，并留下稳定诊断原因。

## 19. 验收标准

- Codex 使用官方逐模型 Credits，而不是统一 GPT 权重。
- Claude 使用带有效期的官方模型相对价格。
- 所有返回非零上游 usage 的模型请求都计入 CU，模型之间仅倍率不同。
- API 等价价值按单请求的真实模型、Standard/Priority、short/long、缓存读写 TTL 和请求时间计算，与额度 CU 使用不同注册表。
- 客户端与服务端对同一请求得出相同 USD、pricing version 和估算质量；Sol golden case 在 Standard short 下严格得到 `$18.27885`。
- 历史金额只能标记为 `exact`、`recalculated` 或 `legacy`；无法精确还原的旧记录不得冒充官方精确价值，UI 不再无条件宣称“已节省”。
- 每次请求累计 CU，普通快照变化不清空窗口累计用量。
- 请求累计 CU 后不使用陈旧母号快照搬动旧归因；新的可信 fraction 变化才触发重算。
- 快照先到、usage report 后到时按事件发生时间重放；上报在 10 分钟乱序期限内到达时，结果必须与相反网络到达顺序一致。
- 母号可信下降和上涨都会立即重算用户额度。
- 5h 和周窗口完全独立，不按模型拆池，不合成最低血条。
- 只有官方 reset 清理对应窗口。
- 不新增历史窗口表。
- 乱序和跨账号快照不能污染当前状态。
- 冷启动不追责历史未知消耗，正常重启连续恢复，中途加订阅不继承旧归因。
- 超卖、独享、席位权重、订单与徽标语义通过旧测试和新算法参数化测试保持不变。
- 客户端—服务端跨进程 E2E 覆盖 reset、resetAt 变化、加入、退出、续费、换号、重启、乱序与并发。
- 所有端到端必跑用例和全局不变量通过后才允许开启 `window-cu-v1`。
- 任一线上问题能在 72 小时内按 trace/report/lease/account/subject 查询完整决策链并导出脱敏支持包。
- 逐请求、额度事件、母号快照和结构化运行日志均执行 72 小时 TTL 与硬容量上限。
- 单体服务只使用进程内单写协调器和微批 checkpoint，不为本功能开启 WAL；当前窗口表规模不随请求量增长。
- 全仓 `pnpm test` 与 quota 跨进程 E2E 全绿，不允许只回归局部额度测试。
- 可以通过环境变量分别回退 Codex 或 Anthropic 到旧算法。
