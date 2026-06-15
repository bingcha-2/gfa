# Fair-share / 学习档案额度系统改造方案

> 日期:2026-06-14 · 基线:`origin/main` HEAD=`171bf14d` · 状态:待评审
> 本方案由多 agent 勘探 + 三版独立设计 + 对抗式审查综合而成。所有行号基于当前 HEAD。

---

## 0. 基线校正(动手前必读)

我们前几轮的讨论基于旧提交 `317f3c1`,但最新代码已不同:

- **`fair-share-tracker.ts` 被 `c8206e79`(9.6.0)重写过**,加入了 per-(planType,family) 的 weekly-ratio floor 机制(`estimatedWeeklyFloor`)。要删的"只升不降棘轮 + 跨窗口保留 + 429 `confirmBudget` SET"**仍然存在**,本方案依然成立。
- **`e27a074c`** 是冲突面 + 可复用脚手架,不是部分实现:
  - 把 `MIN_WEEKLY_RATIO` 从 3 提到 **4.235** → R 的 clamp 现为 **[4.235, 30]**(旧讨论里的 [3,30] 作废,以代码为准;万能卡周限额 `5h×R` 依赖此下限,`access-key-weekly-derived.spec.ts` 断言 `1000×4.235=4235`)。
  - 抽出 **`syncFairShareQuotaSnapshot`**(`lease-service.ts:858`,每次成功 report 都跑)→ 连续采样的天然挂载点。
  - 抽出 **`quotaPercentToFraction`**(对 null/负/NaN 返回 `null`)→ **正好是准入门 A.1「取不到不兜底成 0」的现成实现,直接复用。**
  - 修了 429 周采样取窗错误(用 `weeklyBucketKey` 取周 state)→ 删 429 块时这个"正确窗口 key"语义必须迁移进新路径,**不能回退**。
- **`3ebd27cd`** 纯前端(5h 血条用 5h 窗口自身 reset)→ 服务端须继续分别下发 `tokenWindowResetMs`(5h)与 `weeklyWindowResetMs`(周),本方案保留窗口计时不破坏该契约。
- **`fair-share-tracker.ts` 含一个 NUL 字节(offset ~25387)**,导致 ripgrep 拒绝匹配该文件。改造时顺手清理。

---

## 1. 目标回顾(已确认 A–F)

- **A 连续采样**:每当账号 5h/周剩余 fraction 较上次降约 10% 采一样本;准入门(见 §3 扩充为 6 道)。
- **B 聚合维度**:跨账号 `provider:planType:family`(沿用现有 profile 键),5h 与周各一条。
- **C 预算来源**:废弃 per-account `estimatedBudget` 棘轮 + 跨窗口保留 + `confirmBudget` SET;预算直接取学习档案;每卡 = 档案 × `(weight/capacity)`。
- **D regime 收敛**:档案中位改"时间衰减加权中位"(EWMA 思路),`weight=exp(-(now-t)/τ)`,读时重算。
- **E 保留**:per-card `myUsage`、窗口计时/对齐 reset、样本不足/consumed 太小→回退默认 + `lastFraction≥0.90` leniency 不误杀。
- **F**:R = 卡级 > 学习(weekly中位/5h中位)> 默认 5,clamp **[4.235,30]**;评估周样本不均。

---

## 2. 架构总览(一条自洽链路)

```
连续采样(6 道准入门,挂在 recordUsage 之后)
   │  estimated = totalUsed / (1 - fraction)        ← 仅当 GFA≈该号唯一消费者才有效(门6)
   ▼
跨账号档案 QuotaProfile[provider:planType:family]   ← 带时间戳样本 {v,t}[],5h/周各一条
   │  budget = decayedWeightedMedian(history, now, τ) ← 读时重算 + 秒级缓存 + 坍塌保护
   ▼
fair-share 预算 = budget × (weight / capacity)       ← 5h 与周同构;样本不足→DEFAULT_BUDGETS
```

三套旧口径(运行时棘轮 / 429-only 学习 / R 派生)收敛为这一条。`FairShareTracker` 退化为「窗口计时 + per-card `myUsage` + 读时向档案要预算」。

---

## 3. 对抗式审查发现的关键修正(必须内建,否则会出系统性 bug)

三版评审**一致**命中的硬问题,任何实现都必须先解决:

### 🔴 修正 1 —— 采样时点错位(三评审一致,最高优先级)
`syncFairShareQuotaSnapshot` 在 `reportResult` 的 **L955 调用,早于 L979 的 `recordUsage`**(本次请求用量入账)。若把采样挂在 `syncFairShareQuotaSnapshot` 内读 `getTrackerState().totalUsed`,**本次请求(恰是把 fraction 推过 10% 的那一笔)还没计入 totalUsed** → `estimated = totalUsed/(1-fraction)` 分子系统性少一笔 → 学习预算长期偏低,衰减中位也救不了。
**修法**:连续采样必须放在 **`recordUsage` 之后**(新增独立采样钩子 `sampleProfileAfterUsage`),保证 `totalUsed` 与 fraction(本次 `accountQuota` 后水位)对齐到同一时点。**测试钉死**。

### 🔴 修正 2 —— `totalUsed` 是 GFA 自身用量,fraction 是账号全量(独占假设)
`totalWeighted` = 该号**所有 GFA 卡**的加权用量之和;fraction 是上游**整个号**的剩余(含 GFA 之外的消费)。`estimated = totalUsed/(1-fraction)` **仅当 GFA≈该号唯一消费者时成立**。池卡/号外有人用 → fraction 降但 totalUsed 没涨 → 虚高/虚低样本。
**修法(新增第 6 道准入门,决策④)**:**绑卡(`boundAccountId>0`)跳过门6 默认采**(1 号≈GFA 独占);**池卡/万能卡启用门6**——采样器维护 per-(accountId,bucket) 的上次 `(totalUsed, fraction)`,只在**本次 totalUsed 增量能解释本次 fraction 降幅**(两者大致一致)时才采,不一致(疑似外部消费)→ 丢弃。

### 🔴 修正 3 —— 衰减中位的"静默坍塌"保护
若某号停用 > 数个 τ,所有样本 `weight=exp(-大数)` 下溢→ `total=0` → `decayedWeightedMedian` 返回 0 → 预算坍塌回 DEFAULT。
**修法**:① **时间淘汰只用读时权重衰减,绝不物理删除 history**(`pruneByTimeAndCap` 改为只按条数上限裁剪,不按时间删);② `decayedWeightedMedian` 在有效权重和过小时**回退到最新样本值**,不返回 0;③ 引入**有效样本数** `(Σw)²/Σw²`,供周样本不均判定。

### 🟠 修正 4 —— 周预算权威源(避免地板顶死,阻断下调收敛)
设计初稿的 `max(learnedWeekly, learned5h×R)` 会让官方**周下调**被 `5h×R` 地板顶住,无法收敛。
**修法**:周样本足(`samplesWeekly ≥ MIN_WEEKLY_SAMPLES`)时,**`learnedWeekly` 读时重算为权威**;`5h×clampR` **仅作样本不足时的回退/地板**,不再恒定取 max。

### 🟠 修正 5 —— 跨窗口回升游标必须 per-account 且与 perCard 重置同源
回升检测游标(`lastSampledFraction`)是 **per-account 现象**,放跨账号 `QuotaProfile` 会串台(A 号重置污染 B 号)→ **放 lease-service 的 per-(accountId,bucket) 内存 Map**。且其"窗口重置"判定必须与 `FairShareTracker.perCard` 的清零**同源**:让 `getTrackerState` 额外返回 `windowStart`,采样器比较 `windowStart` 变化来判重置(而非自维护一套 `resetAt` 阈值),消除"幻象负消耗"。窗口重置时把 `lastSampledFraction` 重置为新窗口起始 fraction(否则新窗口前 10% 永远漏采)。

### 🟠 修正 6 —— 读时重算必须带缓存(非可选)
单次 lease 决策会重算同一 profile 4–6 次(`estimatedWeeklyFloor` + `checkWindow` + `weeklyRatioForFamily` + `publicStatus` + `getAllProfiles`)。
**修法**:`getLearnedBudget5h/Weekly`、`getWeeklyToShortRatio` 加**按 now 取整到秒**的 memo。

### 🟡 修正 7 —— `decayedWeightedMedian` 精确定义 + 退化一致性
给出确定的加权分位算法,并**证明所有样本同 t 时退化为现有等权 `median`(含偶数取两中均值四舍五入)**,否则现有 spec 的 round-trip 期望无法复用、大量断言会以非预期方式失败。

### 🟡 修正 8 —— antigravity / 粗粒度上游(Google 20% 档)
`token-server.service.ts` 的 tracker `trackWeekly=false`,Google fraction 20% 粗粒度。"每降 10%"可能长期不触发 → 5h 在 τ 内凑不够样本。
**修法**:粗粒度上游用"fraction 真实变化即采"替代固定 10% 步;antigravity 无周采样属预期(回退 DEFAULT_BUDGETS,目标 E 已覆盖),但要测。

### 🟡 修正 9 —— planType 大小写一致
`profileKey` 写入 `toLowerCase()`,新读路径(采样用 `account.planType` 原样)必须统一小写,否则样本写 `anthropic:max:claude`、读 `anthropic:Max:claude` 会 miss。

### 🟡 修正 10 —— 血条三处与限额同源,标量列读取点全审计
`getCardQuotaFractions:414` / `getCardWeeklyQuotaFractions:447` **直读 `tracker.estimatedBudget` 绕过 floor**(现存 bug)。三处(含 `checkWindow:348`)必须**同一 env 门内原子**切到读时档案,并审计 `window5h/weekly` 标量列所有读取点,避免"限额用衰减值、展示用旧标量"分叉。

---

## 4. 逐文件改动

### 4.1 `apps/api/src/lease-core/quota-profile-tracker.ts`

| 目标 | 改前 | 改后 |
|---|---|---|
| `interface QuotaProfile` (L19-34) | `history5h: number[]; historyWeekly: number[]` | 新增 `export interface QuotaSample { v:number; t:number }`;`history5h/Weekly: QuotaSample[]`。`window5h/weekly` 保留为"读时重算快照/降级安全网"。`samples5h/Weekly`、`lastUpdatedAt` 保留。**不**在此放回升游标(改 §4.3 内存 Map)。 |
| 常量区 (L36-45) | `MAX_HISTORY=20; MIN_SAMPLE_THRESHOLD=10_000` | 新增 `DECAY_TAU_5H_MS`(env `BCAI_QUOTA_DECAY_TAU_MS`,默认 **1.5d**)、`DECAY_TAU_WEEKLY_MS`(env `BCAI_QUOTA_DECAY_TAU_WEEKLY_MS`,默认 **8d**)(决策③)、`MIN_CONSUMED_TO_SAMPLE`(env,默认 0.2,clamp[0.01,0.9])、`SAMPLE_DROP_STEP=0.10`、`MIN_WEEKLY_SAMPLES`(env,默认 **8**,决策②)、`CONSISTENCY_TOLERANCE`(门6 容差)。`MAX_HISTORY` 提到 ~50,**仅按条数裁剪,不按时间物理删**(修正 3)。`MIN_SAMPLE_THRESHOLD` 保留。 |
| `median()` (L274-281) | 等权排序中位 | 新增 `decayedWeightedMedian(samples, now, tau)`:权重 `exp(-max(0,now-t)/tau)`;按 v 升序;累计权重达半处取值(**修正 7:精确定义为加权分位,所有样本同 t 时退化为等权 median**);有效权重和过小→返回最新样本值(**修正 3 坍塌保护**)。保留 `median` 供退化测试与阶段2。 |
| `recordExhaustion()` (L97-130) → `recordSample()` | `estimated = consumed>0.1 ? used/consumed : used`;push 裸 number | 重命名/重写 `recordSample(product,planType,family,totalUsed,fraction:number\|null,isWeekly)`:门1 `fraction==null \|\| !isFinite → return`;门4 `used<MIN_SAMPLE_THRESHOLD → return`;门3 `consumed=1-clamp01(fraction); consumed<MIN_CONSUMED_TO_SAMPLE → return`(**删除旧 0.1 兜底**);`estimated=used/consumed`;push `{v:estimated,t:nowFn()}`;按条数裁剪;`samples++`;标 dirty。**不**在此固化 window(读时重算)。门2/门6/10% 触发在调用方(§4.3),`recordSample` 内保留门1/3/4 作最后防线。 |
| `getLearnedBudget5h/Weekly` (L147-156) | `return profile?.window5h\|\|0` | 读时重算 + 秒级缓存(**修正 6**):5h 用 `DECAY_TAU_5H_MS`、weekly 用 `DECAY_TAU_WEEKLY_MS`(决策③)。无样本→返回 0(触发 DEFAULT 回退,目标 E)。 |
| `getWeeklyToShortRatio` (L162-168) | `clampWeeklyRatio(p.weekly/p.window5h)` | **决策②:过渡期一律回退 `DEFAULT_WEEKLY_RATIO=5`**,仅当 `samplesWeekly ≥ MIN_WEEKLY_SAMPLES(8)` 且有效样本数 `(Σw)²/Σw² ≥ 5` 才用读时重算的 `bw/b5`。clamp[4.235,30] 不变。 |
| `getAllProfiles` (L137-144) | 浅拷贝 `window5h/weekly` 缓存 | status 输出改读时重算值(**修正 10**,与 enforce 同源)。 |
| `load` + `parseNumArray` (L171-272) | 解析 `number[]` | `parseSampleArray(raw, fallbackT)`:旧裸 `number` → `{v, t: now-3τ}`(**保守最小权重**,修正 5 评审:**不要**用 `lastUpdatedAt`,否则旧样本同获高权重压住收敛);`{v,t}` 原样。 |
| `flush` (L192-221) | 序列化 `number[]` | 序列化 `{v,t}[]`;`window5h/weekly` 写"当前 now 重算快照"作降级网。**注意**:`flush` 同步构造 data 再 `await upsert`,不要在 await 边界跨读写 history 数组(并发安全)。 |

### 4.2 `apps/api/src/token-server/fair-share-tracker.ts`

| 目标 | 改前 | 改后 |
|---|---|---|
| `BucketTracker` (L84-92) | 含 `estimatedBudget; confidence` | 删两字段:`{ windowMs; windowStart; perCard; lastFraction }`。 |
| `estimatedBudgetForKey` (L464-472) → `resolvedBudgetForKey` | 读 `tracker.estimatedBudget` | 5h:`learned=getLearnedBudget?.(planType,base)\|\|0; return learned>0?learned:DEFAULT_BUDGETS`。周:`learnedW=getLearnedWeeklyBudget?.()\|\|0; return (samplesWeekly够 && learnedW>0)?learnedW:estimatedWeeklyFloor()`(**修正 4:不再恒 max**)。完全不读 `tracker.estimatedBudget`。 |
| `estimatedWeeklyFloor` (L474-483) | `floor=max(default,learned,current5h)` | 删 `current5h`(棘轮已退役);`floor=max(default5h, learned5h读时) × clampWeeklyRatio(getWeeklyRatio ?? WEEKLY_BUDGET_MULTIPLIER)`。仅作样本不足回退地板。 |
| `checkWindow` (L318-367) | `perCardBudget = estimatedBudgetForKey(...) × w/cap` | 改 `resolvedBudgetForKey(...)`;`lastFraction≥0.90` 放行、`myUsage`、拦截逻辑全保留(目标 E)。 |
| `getCardQuotaFractions:414` / `getCardWeeklyQuotaFractions:447` | 直读 `tracker.estimatedBudget` | 改 `resolvedBudgetForKey(...) × w/cap`(**修正 10**,修血条/限额分叉 bug)。 |
| `updateBudgetEstimate` (L243-272) | 只升不降棘轮 + 5×widen | 瘦身为 `{ ensureWindow; tracker.lastFraction=fraction; dirty=true }`。删所有 `estimatedBudget` 写入。保留方法名(`syncFairShareQuotaSnapshot` 调它维护 `lastFraction`,leniency/血条依赖)。 |
| `confirmBudget`/`confirmWeeklyBudget` (L275-285,381-384) | per-account SET | 删方法体(调用点见 §4.3)。保留一周期 no-op 再删。`getTrackerState` 去掉 `confidence`、**新增返回 `windowStart`**(修正 5)、保留 `totalUsed/lastFraction`。 |
| `ensureWindow` (L517-527) / `syncWindow` (L210-222) | 跨窗口 RETAIN `estimatedBudget` + confidence 降级 | 只保留 `windowStart` 重置 + `perCard.clear()`(+ 重置时 `lastFraction→1` 恢复 leniency);删 estimatedBudget 保留与 confidence 降级。 |
| `getOrCreate` (L485-515) | seed estimatedBudget/confidence | 只初始化 `{windowMs, windowStart, perCard, lastFraction:1.0}`。 |
| `load`/`serializeRows` (L560-680) | 读写 estimatedBudget/confidence | 只读写 `weightedUsed/windowStart/lastFraction`;estimatedBudget/confidence 列写默认值(分两步退役,§9)。 |

### 4.3 `apps/api/src/lease-core/lease-service.ts`

| 目标 | 改后 |
|---|---|
| **新增 `sampleProfileAfterUsage(...)`**,在 `reportResult` 的 **`recordUsage`(L979)之后**调用(**修正 1**) | per-(accountId,bucket,scope) 内存 Map 持有 `{lastSampledFraction, lastWindowStart, lastTotalUsed}`。对 5h/周各跑:① `fraction=quotaPercentToFraction(...)`,null→跳(门1);② 读 `state=getTrackerState(accountId, scope===weekly?weeklyBucketKey(bucket):bucket)`(**正确取窗,沿用 e27a074c**);③ `state.windowStart` 变化 → 窗口重置,重置 `lastSampledFraction=fraction`、不采(**修正 5 同源**);④ 门6 一致性:`(state.totalUsed-lastTotalUsed)` 与 `(lastSampledFraction-fraction)` 不一致→丢(**修正 2**);⑤ `lastSampledFraction-fraction ≥ SAMPLE_DROP_STEP` → `recordSample(provider.id, planType.toLowerCase(), family, state.totalUsed, fraction, isWeekly)`,更新游标。粗粒度上游用"真实变化即采"(**修正 8**)。 |
| `syncFairShareQuotaSnapshot` (L858-909) | 保留 `updateBudgetEstimate`/`syncWindow`(现已瘦身为维护 `lastFraction` + 对齐窗口);回退分支 L888-897 **收紧:跳过 fraction===0/缺失**(门1 精神,不再"没数据当 0%")。 |
| 429 块 (L1057-1083) | 删 `confirmBudget/confirmWeeklyBudget`(目标 C);**改为调一次普通 `recordSample(...)`**(用真实 fraction,consumed≈1,不特殊加权——决策①密度兜底)。`markAccountExhausted`/cooldown 保留。 |
| `weeklyRatioForFamily` (L722-733) | 逻辑不变(卡级>学习>默认,clamp[4.235,30]),自动受益于 `getWeeklyToShortRatio` 的读时重算 + 周样本门。 |

### 4.4 接线(三个 service)
`remote-anthropic/remote-codex/token-server` 的 `FairShareTracker` 构造里 `getLearnedBudget/getLearnedWeeklyBudget/getWeeklyRatio` 回调**已存在**,无需改签名——它们从"floor/seed"升级为"权威预算源"靠的是 §4.2 `resolvedBudgetForKey` 改读它们,接线不动。

---

## 5. 数据结构与 schema(`prisma/schema.prisma`)

- **`QuotaProfile` (L501-514)**:`history5h/historyWeekly` 列类型**保持 String**,JSON 内容语义 `number[]→{v,t}[]`(**零破坏性 DDL**,纯数据格式迁移)。`window5h/weekly` Float 保留为"读时重算快照/降级网"。注释更新。
- **`FairShareWindow` (L518-532)**:`estimatedBudget/confidence` 两列**分两步退役**——第一步保留列、代码停读、写默认值(`@default` 已有,`createMany` 省略安全);下一发布周期单独出 `DROP COLUMN` migration。`weightedUsed/windowStart/lastFraction` 保留(目标 E)。
- **回升游标不落库**(修正 5,放内存),**零新增列**。重启后首样本不采、下个 10% 降幅重建基线(影响极小)。

---

## 6. 配置(env,全部有默认值)

| env | 默认 | 作用 |
|---|---|---|
| `BCAI_QUOTA_DECAY_TAU_MS` | 1.5d | τ_5h,5h 收敛速度(决策③) |
| `BCAI_QUOTA_DECAY_TAU_WEEKLY_MS` | 8d | τ_weekly,周收敛速度(决策③) |
| `BCAI_QUOTA_MIN_CONSUMED` | 0.2 | 准入门3,躲 fraction→1 放大 |
| `BCAI_MIN_WEEKLY_SAMPLES` | 8 | 信任学习 R 的最小周样本数(决策②,另需有效样本数≥5) |
| `BCAI_QUOTA_MAX_HISTORY` | 50 | 样本条数上限(只按条数裁剪) |
| `BCAI_CONTINUOUS_SAMPLING` | off | 阶段1 开关 |
| `BCAI_BUDGET_FROM_PROFILE` | off | 阶段2 开关 |
| `BCAI_QUOTA_USE_DECAY` | off | 阶段3 开关 |
| 沿用不变 | — | `BCAI_WEEKLY_RATIO_DEFAULT=5`、`MIN/MAX_WEEKLY_RATIO=4.235/30`、`MIN_SAMPLE_THRESHOLD=10_000`、`BCAI_ACCOUNT_SHARE_CAPACITY=8` |

---

## 7. 分阶段上线(三个独立 env 门,默认 OFF,可逐级回退)

- **阶段 1 `BCAI_CONTINUOUS_SAMPLING`**:连续采样**并行影子记录**(不改预算/计费)。生产灰度观察 `samples5h/Weekly` 增速、`history{v,t}` 是否合理、有无"0% 打穿"。**这一阶段就能暴露修正 1/2 的采样质量问题**——放行门禁。
- **阶段 2 `BCAI_BUDGET_FROM_PROFILE`**:fair-share 预算读时取档案(仍用等权中位),废弃棘轮/confirmBudget。对照新旧每卡额度差异,确认无大幅误杀/放水。血条三处与限额**同门原子**切换(修正 10)。
- **阶段 3 `BCAI_QUOTA_USE_DECAY`**:`getLearnedBudget*`/`getWeeklyToShortRatio` 切 `decayedWeightedMedian` 读时重算。专项收敛测试。

任一阶段出问题,关对应 env 即回上一阶段;旧路径用 `if` 包住,稳定 1–2 周期后物理删除。

---

## 8. 测试计划

**单测(`quota-profile-tracker.spec.ts`)**
- 改 L42-48:语义反转——`consumed<0.2`(fraction=0.95)样本**被丢弃**,而非走 totalUsed 兜底。
- 改 L26-40 / L58-69 / round-trip L87-107:history 形态 `[num]→[{v,t}]`;新增旧 `number[]` 向后兼容(升级 `{v, t:now-3τ}`)。
- 改 L129-164:`getWeeklyToShortRatio` 加 `MIN_WEEKLY_SAMPLES` 门用例;保留 4.235/30 clamp 断言。
- 新增:门1 null 丢弃;门3 边界 0.19 丢 / 0.20 采(注意浮点容差用 `≥`);**门6 一致性**(totalUsed 增量与 fraction 降幅不符→丢);**修正 1 时序**(采样读到的 totalUsed 已含本次用量,集成测试);**修正 3 坍塌**(全样本过旧→不返回 0 而回退最新样本);衰减收敛(注入 now+τ,100M→80M 在 1–2τ 内对称收敛);读时重算(同 history 随 now 变);τ env 可配;窗口重置(`windowStart` 变化)重置游标不产样本。

**单测(`fair-share-tracker.spec.ts`)**
- 改 L107-122「keeps the learned budget」→ 断言 perCard 清空 + 预算由档案 mock 读时算。
- 改 L302-313「sparse weekly 不缩到 5h×R 以下」→ 断言走 `resolvedBudgetForKey/estimatedWeeklyFloor`。
- 保留 dual-window / 0.90 leniency / reset-align / weightedCost / QUOTA_WEIGHTS(回归网,目标 E)。
- 新增:血条与 enforce 同源(修 L414/L447)。

**集成 / 回归**
- `remote-anthropic.service.spec.ts`:429 采样断言改为"连续采样在 fraction 降 10% 时 `recordSample`";429 不再 `confirmBudget`。
- `access-key-weekly-derived.spec.ts`:4.235 下限 → 4235 断言**逐用例**核对(R 回退 5 时派生值会变,见修正);新增"周样本不足→R=5"用例。
- `lease-service.spec.ts`:窗口对齐(L505-601)+ per-card cap(L478-503)必须**继续通过**(目标 E)。
- 端到端:旧 `number[]` 行 load 升级;新 `{v,t}` 行被旧代码读(回退)不崩。
- `pnpm --filter @gfa/api test` 全绿 + `typecheck`。

---

## 9. 迁移与回退

- **零破坏性 DDL 上线**:先部署后端(读时重算 + 连续采样 + 兼容旧数据读),DB 无需先迁;稳定后再做 `FairShareWindow` 列清理 migration。
- **向前兼容**:`parseSampleArray` 吃旧 `number[]`(升级 `{v, t:now-3τ}` 最小权重)。
- **回退到旧二进制**:旧 `parseNumArray` 对 `{v,t}` 做 `Number→NaN` 过滤(丢 history 但 `window5h` 标量列仍在→旧棘轮用标量续命,不崩、不打穿)。**注意边界**:刚迁移就回退、`window5h` 快照可能未写过→需在阶段1 flush 至少写一次保守快照兜底。
- **429 路径转换而非删除**(决策①):`recordExhaustion`→`recordSample` 兜底样本保留,因此切换期**不存在"学习静默归零"风险**(连续采样未上线时,429 仍在喂档案)。仅 `confirmBudget` 的 per-account SET 被删。

---

## 10. 已锁定决策(2026-06-14 确认)

### ✅ 决策① 429 保留为"普通样本"做密度兜底
删除 `confirmBudget`/`confirmWeeklyBudget` 的 per-account SET(目标 C),但 **429 时仍走一次普通 `recordSample`**(用真实 fraction,consumed≈1 的高质量样本,**不特殊加权**)。
- 落地:`recordSample` 有**两个**调用点——`sampleProfileAfterUsage`(连续,每降10%)+ 429 块(兜底)。
- 连带收益:不再有"删 429-only 后学习静默"的断流风险,也缓解了 leniency 信号断流(§3 评审关注点)。

### ✅ 决策② 过渡期周一律 `R = DEFAULT 5`
周窗口**暂不信学习 R**,`getWeeklyToShortRatio` 一律回退 `DEFAULT_WEEKLY_RATIO=5`,直到周样本养够:**`samplesWeekly ≥ 8` 且有效样本数 `(Σw)²/Σw² ≥ 5`** 才切换到学习 R。
- 落地:`MIN_WEEKLY_SAMPLES` 默认 8 + 有效样本数门;门未过 → 返回 5(经外层 clamp 仍是 5,在 [4.235,30] 内)。

### ✅ 决策③ τ 5h 与周分开
- `τ_5h`:env `BCAI_QUOTA_DECAY_TAU_MS`,默认 **1.5 天**(样本密、跟得快)。
- `τ_weekly`:env `BCAI_QUOTA_DECAY_TAU_WEEKLY_MS`,默认 **8 天**(样本稀、窗口长、要更稳)。
- 落地:`getLearnedBudget5h` 用 τ_5h,`getLearnedBudgetWeekly` 用 τ_weekly;`decayedWeightedMedian` 的 τ 由调用方按 scope 传入。

### ✅ 决策④ 门6 绑卡放宽
**绑卡(`boundAccountId>0`,1 号≈GFA 独占)默认采样、不做一致性校验**;**池卡/万能卡(无固定绑定)启用门6**(本次 totalUsed 增量须能解释 fraction 降幅,不一致即丢)。
- 落地:`sampleProfileAfterUsage` 内按 `record.boundAccountId>0 ? 跳过门6 : 启用门6` 分支。
