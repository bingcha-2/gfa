# Fair-Share 双窗口(5h + 周)设计说明书

本文档描述给绑定卡 fair-share(公平分账)补上**周窗口**的设计。当前 fair-share 只建模一个固定 5h 窗口,对 Anthropic / Codex 的**周级上限**完全无感知,会出现 fair-share 没预测到的 429,以及窗口对齐错位。本方案让每个 bucket 同时跟踪「5h(fast)」与「周(slow)」两个窗口,份额剩余取两者更紧的一个(min)。

- 状态:草案(Draft)
- 范围:`apps/api`(lease-core / token-server / prisma),`apps/web` 仅文案
- 分阶段推进(每阶段独立可上线、可回滚):
  - **Phase 1(必做,低风险)**:双窗口(5h + 周)取 min —— 堵掉唯一真缺口,数据现成。见 §2。
  - **Phase 2(值得,低风险)**:带外用量修正 —— 让份额估算感知「代理外消耗」,修掉过度保守。见 §8.1。
  - **Phase 3(值得,中风险重构)**:换框架到 fraction 空间 —— 不再猜绝对预算,直接用上游已知 remaining% 分账,本质更稳。见 §8.2。
- 不改:工作保全/借份额、capacity 分母逻辑(见 §6 不做什么)

---

## 1. 需求背景与问题分析

### 1.1 现状回顾

绑定卡 fair-share 由 [`FairShareTracker`](../../../apps/api/src/token-server/fair-share-tracker.ts) 实现,核心:

```
本卡配额 perCardBudget = 账号总预算(estimatedBudget) × (本卡 weight / 总份数 ACCOUNT_SHARE_CAPACITY)
份额剩余%             = max(0, perCardBudget − 本卡本窗口已用) / perCardBudget
```

- 「本卡已用」实测:每次上报按加权 token 累加([`recordUsage`](../../../apps/api/src/token-server/fair-share-tracker.ts))。
- 「账号总预算」估算,三级置信度:① 套餐默认表 → ② `已用/(1−上游剩余%)` 反推(只升不降)→ ③ 撞 429 锚定。
- 窗口长度写死 **5h**:`const WINDOW_MS = 5 * 60 * 60 * 1000`。
- 喂数源:`reportResult` 把 `account.modelQuotaFractions[model]` 推进 [`updateBudgetEstimate`](../../../apps/api/src/lease-core/lease-service.ts#L779),把 `modelQuotaResetTimes[model]` 推进 `syncWindow`。
- 持久化:Prisma `FairShareWindow`,主键 `@@id([provider, accountId, bucket, cardId])`,单窗口字段 `windowStart / weightedUsed / estimatedBudget / confidence / lastFraction`。

### 1.2 问题

御三家的真实限额形态:

| 产品 | 限额窗口 |
|---|---|
| Anthropic(Claude) | **5h + 周** 双限 |
| Codex(ChatGPT) | **5h + 周** 双限 |
| Antigravity(Gemini) | 仅 5h |

控制台血条已经在展示双水位(`5h 55% · 周 96%`,来自 `families` / `quotaSnapshotInputs`),但 **fair-share 只吃了一个 5h 窗口**,导致:

1. **周上限不可见**:一张卡可能在自己的 5h 份额内,但账号撞的是**周上限** → 产生 fair-share 完全没预测到的 429。fair-share 作为「软分账」的意义在周维度上失效。
2. **窗口对齐可能错位**:`syncWindow` 用 `windowStart = resetMs − WINDOW_MS(5h)` 倒推窗口起点。若喂进来的 `modelQuotaResetTimes` 是**周维度**的 reset,窗口起点会被算成「周 reset 前 5h」,与真实周窗(7 天)严重错位,`perCard` 清零时机也错。
3. **喂数源语义含糊**:`modelQuotaFractions[model]` 每模型只有一个 fraction,究竟代表 5h 还是周并不明确,而 `provider.quotaSnapshotInputs()` 早已统一提供了 `hourlyPercent / weeklyPercent / hourlyResetAt / weeklyResetAt`,却没被 fair-share 使用。

### 1.3 目标 / 非目标

- **Phase 1 目标**:fair-share 同时跟踪 5h 与周两个窗口;份额剩余、限额判定均取两窗 min;Antigravity(无周)行为完全不变;可持久化、可回滚。
- **后续阶段**:Phase 2 带外用量修正、Phase 3 fraction 空间重构,设计见 §8(本轮先实现 Phase 1)。
- **非目标(永不做)**:借份额/工作保全、改 capacity 分母——见 §6。

---

## 2. 方案设计

### 2.1 数据结构:每 bucket 两个子窗口

把现有「一个 bucket 一个 tracker」升级为「一个 bucket 两个子窗口」。引入窗口种类:

```ts
type WindowKind = "fast" | "slow"; // fast = 5h, slow = 周(7d)

const WINDOW_MS: Record<WindowKind, number> = {
  fast: 5 * 60 * 60 * 1000,
  slow: 7 * 24 * 60 * 60 * 1000,
};

interface BucketTracker {
  windows: Record<WindowKind, WindowState | undefined>; // slow 缺省=该产品无周窗(antigravity)
}

interface WindowState {
  windowStart: number;
  estimatedBudget: number;
  confidence: "default" | "estimated" | "confirmed";
  perCard: Map<string, number>; // cardId → 本窗口加权已用
  lastFraction: number;
}
```

要点:
- 同一次请求的加权成本**同时**累加进 fast 与 slow 两个 `perCard`(同一批 token 既消耗 5h 额度也消耗周额度)。
- 两窗口**独立重置**:fast 每 5h、slow 每周,各自对齐上游 reset。
- `slow` 为 `undefined` 表示该产品没有周窗(antigravity)→ 所有取 min 逻辑自动退化为只看 fast,行为与今日一致。

### 2.2 取数与判定:两窗取 min

[`checkFairShare`](../../../apps/api/src/token-server/fair-share-tracker.ts) 与 [`getCardQuotaFractions`](../../../apps/api/src/token-server/fair-share-tracker.ts) 改为对每个存在的窗口各算一遍 fraction,**取最小**:

```ts
// 每窗口单独算 fraction(沿用现有逻辑:≥90% 直接给上游 fraction;否则按 perCardBudget 减法)
fractionFast = fractionOfWindow(tracker.windows.fast, cardId);
fractionSlow = tracker.windows.slow ? fractionOfWindow(tracker.windows.slow, cardId) : 1;

remainingFraction = Math.min(fractionFast, fractionSlow);
allowed = remainingFraction > 0; // 任一窗口用尽即拦
reason  = 取触发 0 的那个窗口("公平限额(5h)用完" / "公平限额(周)用完")
```

- `getCardQuotaFractions` 返回每 bucket 的 `{ fraction: min(两窗), resetAt: 对应更紧窗口的 reset }`,供血条显示**真实的绑定约束**(哪个窗口更紧就显示哪个)。
- 现有「≥90% 直接放行/直接显示上游 fraction」的宽松规则**逐窗口**保留。

### 2.3 喂数:改用 `quotaSnapshotInputs`(双水位)

把 `reportResult` 里的喂数源从 `modelQuotaFractions` 切到 [`provider.quotaSnapshotInputs(account)`](../../../apps/api/src/lease-core/provider.ts#L65),它统一返回每 modelKey 的 `hourlyPercent / weeklyPercent / hourlyResetAt / weeklyResetAt`:

```ts
for (const snap of provider.quotaSnapshotInputs?.(account) ?? []) {
  const bucket = bucketKey(provider.id, snap.modelKey);
  if (snap.hourlyPercent != null)
    tracker.updateBudgetEstimate(accountId, bucket, "fast", snap.hourlyPercent / 100);
  if (snap.hourlyResetAt)
    tracker.syncWindow(accountId, bucket, "fast", snap.hourlyResetAt.getTime());
  if (snap.weeklyPercent != null)
    tracker.updateBudgetEstimate(accountId, bucket, "slow", snap.weeklyPercent / 100);
  if (snap.weeklyResetAt)
    tracker.syncWindow(accountId, bucket, "slow", snap.weeklyResetAt.getTime());
}
```

- `syncWindow(kind)` 用 `windowStart = resetMs − WINDOW_MS[kind]`,fast 减 5h、slow 减 7d——**对齐错位问题就此修复**。
- 无 `quotaSnapshotInputs` 的 provider(理论上不存在,做兜底)回落旧的 `modelQuotaFractions` → 只喂 fast,等价今日。

### 2.4 周窗口的默认预算

新增 slow 窗口默认表 `DEFAULT_BUDGETS_WEEKLY`(或对 5h 表乘一个保守系数,如 `×10`)。说明:
- 该默认仅用于「窗口内尚未出现任何 ② 反推 / ③ 429 信号」的极早期;一旦上游周 fraction 或周 429 到来即被覆盖。
- 系数/表值无需精确(与 5h 默认同理),宁可偏大(宽松),真护栏仍是上游 429。

### 2.5 持久化:`FairShareWindow` 加窗口维度

Prisma 模型加 `windowKind` 进主键,使每 `(provider, accountId, bucket, cardId)` 最多两行:

```prisma
model FairShareWindow {
  provider        String
  accountId       Int
  bucket          String
  cardId          String
  windowKind      String   @default("fast")  // "fast" | "slow"  ← 新增
  windowStart     BigInt
  weightedUsed    Float    @default(0)
  estimatedBudget Float    @default(0)
  confidence      String   @default("default")
  lastFraction    Float    @default(1)
  updatedAt       DateTime @default(now())

  @@id([provider, accountId, bucket, cardId, windowKind])  // ← 加 windowKind
  @@index([provider, accountId, bucket])
}
```

- `load` / `serializeRows` / `flush` 按 `windowKind` 读写两组窗口。
- `flush` 仍是「按 provider 全删全建」事务,不留陈行,天然适配新增维度。
- 迁移:`windowKind` 有默认 `"fast"`,旧行自动归入 fast 窗口;首次启动后周窗口随上报逐步补齐。无需数据回填脚本。

### 2.6 开关与回滚

加环境变量 `BCAI_FAIR_SHARE_DUAL_WINDOW`(默认 `true`):
- `true`:启用双窗口。
- `false`:`slow` 永不创建,取 min 退化为只看 fast,喂数只喂 fast → **行为完全等同今日**,作为线上快速回滚开关。

### 2.7 客户端展示:「我的份额」也要双条

现状:客户端([apps/bcai-wails](../../../apps/bcai-wails/bloodbar.go))**整号视角**早有 5h + 周 双条(`quotaWindowStatus`),但**「我的份额」(fair-share)视角只有一条** `MyFraction`——因为 lease 响应里 `fairShareQuota[bucket]` 只下发一个 `{ fraction, resetAt }`([leaser_status.go:209](../../../apps/bcai-wails/leaser_status.go#L209))。Phase 1 取 min 后,这一条会变成「更紧窗口」,但用户**看不出是 5h 还是周在卡、几时恢复**。所以「我的份额」也要拆成两条。

**服务端(向后兼容地扩展 `fairShareQuota`)**。`getCardQuotaFractions` 在返回 min 的同时,附带两个子窗口:

```jsonc
fairShareQuota[bucket] = {
  fraction, resetAt,               // = min(两窗) —— 旧客户端只读这两个 → 显示更紧窗口,仍正确
  hourly: { fraction, resetAt },   // 5h 份额
  weekly: { fraction, resetAt },   // 周份额(antigravity 等无周窗的产品省略此键)
}
```

**客户端(bcai-wails)**:
- `bucketQuota` 加 `MyHourlyFraction/MyHourlyResetAt/MyWeeklyFraction/MyWeeklyResetAt`;
- `recordFairShareQuota` 解析新增的 `hourly/weekly`(旧 `fraction/resetAt` 仍读,作兜底);
- 「我的份额」血条由一条改两条(5h + 周),与「整号」视角的 `quotaWindowStatus` 对齐;
- `snapshotMyFractions`(经 [app.go](../../../apps/bcai-wails/app.go#L231) 的 `myFractions` 暴露给前端)同步带上两个窗口。

**兼容 / 发版:强制升级**。
- 采用**强制升级**:抬高服务端 `minClientVersion` 地板([lease-service.ts:215](../../../apps/api/src/lease-core/lease-service.ts#L215),默认 `9.2.4`),低于地板的老客户端 lease 时被 [`validateClientVersion`](../../../apps/api/src/token-server/token-billing.ts#L517) 拦下,返回 **426「当前插件版本过低」**(带 `upgradeUrl`),用户必须更新到新版才能继续用。
- 这样保证**所有在用客户端都显示正确的双条**,不存在「老客户端只看到更紧窗口、不知是 5h 还是周」的中间态。
- `fairShareQuota[bucket]` 仍保留汇总字段 `fraction/resetAt`(=min)以防其它读取方,但强制升级后客户端一律读 `hourly/weekly`。
- ⚠️ **发版次序硬约束(防全员锁死)**:**必须先发布新 Wails 客户端**(`build-wails.yml` 出包 + `updater.go` 的 `AppVersion` 抬到新版)、确认更新通道可用,**再抬服务端 `minClientVersion` 地板到该新版本**。地板**绝不能**抬到「尚未发布的版本」之上,否则所有人立刻 426 被锁死且无版本可升。见 `gfa-service-ops`。

**控制台(apps/web)**:per-card「份额剩余」列保持显示 min(管理员视角够用),靠已扩充的 tooltip 说明「取 5h 与周更紧的一个」,不另加列。

---

## 3. 影响面(Phase 1)

| 文件 | 改动 |
|---|---|
| `apps/api/src/token-server/fair-share-tracker.ts` | 核心:双窗口数据结构、`recordUsage/updateBudgetEstimate/confirmBudget/syncWindow/ensureWindow` 加 `kind`、`checkFairShare/getCardQuotaFractions` 取 min、`load/flush/serializeRows` 按 kind、`DEFAULT_BUDGETS_WEEKLY` |
| `apps/api/src/lease-core/lease-service.ts` | `reportResult` 喂数源改 `quotaSnapshotInputs`(fast+slow);429 `confirmBudget` 对两窗都锚定 |
| [`prisma/schema.prisma`](../../../prisma/schema.prisma) | `FairShareWindow` 加 `windowKind` 进 PK + migration |
| `apps/api/src/lease-core/lease-service.ts`(响应) | `fairShareQuota[bucket]` 向后兼容扩成含 `hourly/weekly` 子窗口(`fraction/resetAt` 仍为 min) |
| `apps/web/.../BoundCardAccordion.tsx` | 文案:`份额剩余` tooltip 注明「取 5h 与周更紧的一个」(已部分更新);per-card 列仍显示 min |
| `apps/bcai-wails/bloodbar.go` / `leaser_status.go` / `app.go`(+前端) | 「我的份额」血条由一条改两条(5h+周);解析新 `fairShareQuota.hourly/weekly`;`myFractions` 带两窗口。需 Wails 发版 + 抬 `updater.go` 的 `AppVersion` |
| `apps/api`(`minClientVersion` 地板) | **强制升级**:新客户端发布后,把地板抬到该新版本([lease-service.ts:215](../../../apps/api/src/lease-core/lease-service.ts#L215)),老客户端 426 被拦 |

`checkFairShare` / `getCardQuotaFractions` 的内部计算改双窗口取 min;`getCardQuotaFractions` 的**返回结构向后兼容扩展**(旧 `fraction/resetAt` 保留 + 新增 `hourly/weekly`)。lease-service 调用点无需改;429 的 `reason` 文案细化为带窗口名。

---

## 4. 测试方案(Phase 1)

新增 `fair-share-dual-window.spec.ts`,关键用例:

1. **周更紧 → 取周**:fast 充裕(如 80%)、slow 紧张(如 5%)→ `getCardQuotaFractions` 返回 ≈5%,`checkFairShare` 在周维度拦截,reason 含「周」。
2. **5h 更紧 → 取 5h**:反之,返回 5h 值,reason 含「5h」。
3. **antigravity 无周窗**:只喂 fast,`slow` 始终 `undefined`,fraction == fast,行为与改动前逐字节一致(回归)。
4. **窗口独立重置**:fast 跨 5h 重置清零 perCard,slow 仍累计;反之。
5. **对齐修复**:喂周 reset,窗口起点 = reset − 7d(非 − 5h)。
6. **持久化往返**:两窗口 `flush` → `load` 还原一致;旧行(无 `windowKind`)按 fast 加载。
7. **429 双锚定**:撞 429 后 fast 与 slow 的 `estimatedBudget` 均被 `confirmBudget` 锚定到各自当时已用。
8. **开关 off**:`BCAI_FAIR_SHARE_DUAL_WINDOW=false` 下退化为单窗口(等同现有 `fair-share-tracker` 既有测试全过)。
9. **响应结构**:`fairShareQuota[bucket]` 同时含 `fraction/resetAt`(=min,汇总兜底)与 `hourly/weekly`;强制升级后客户端读 `hourly/weekly` 显示双条。
10. **客户端解析(bcai-wails)**:`recordFairShareQuota` 解析 `hourly/weekly` → `MyHourly*/MyWeekly*`;缺 `weekly` 键(antigravity)时只显示 5h 一条。
11. **版本闸(强制升级)**:`< 地板` 的客户端 lease 返回 426「当前插件版本过低」带 `upgradeUrl`;`≥ 地板` 正常。(`validateClientVersion` 既有测试覆盖,本项确认地板抬高后老版本被拦。)

回归:`fair-share-tracker` 现有单窗口测试在开关 off 下必须全绿;开关 on 下若断言只看单窗口,按需调整为 min 语义。

---

## 5. 上线步骤(Phase 1)

1. Prisma migration(加 `windowKind`),先发**仅加列**、应用层暂不读新维度(双部署安全)。
2. 部署应用层(开关默认 on)。`flush` 自然写入两组行;lease 响应开始带 `fairShareQuota.hourly/weekly`(老客户端忽略,仍读 min)。
3. 观察:控制台份额剩余是否对齐血条周水位;是否仍出现「份额显示充裕却 429」。
4. 异常时 `BCAI_FAIR_SHARE_DUAL_WINDOW=false` 秒级回滚到单窗口。
5. **Wails 客户端发版(强制升级,严格按序)**:
   a. 实现客户端双条 UI + 解析 `hourly/weekly`,走 `build-wails.yml` 出包,抬 `updater.go` 的 `AppVersion` 到新版本 `vX`。
   b. 发布 release、**确认自动更新通道能拉到 `vX`**(灰度/自测一台老机器能升上来)。
   c. **确认 `vX` 已可用后**,再把服务端 `minClientVersion` 地板抬到 `vX`。此后 `< vX` 的老客户端 lease 时 426 被拦,被迫更新。
   - ❌ 严禁顺序颠倒:地板抬到尚未发布的版本 = 全员立刻 426 且无版本可升(锁死)。

---

## 6. 不做什么(永不做)

以下与 fair-share 的定位冲突或属过度工程,**所有阶段均不做**:

- **工作保全 / 借份额**:同号闲卡不向热卡出借份额,维持纯静态切分(借份额会让卡在闲卡苏醒时被突然限流,体验不可控)。
- **capacity 分母**:维持固定 `ACCOUNT_SHARE_CAPACITY`(默认 8),「号没卖满不吃空额」是既定取舍(份额稳定优先于利用率)。

> 注:`已用/(1−fraction)` 只升不降的乐观偏差、429 锚定对带外用量的偏差,**不再列为「不做」**——Phase 2 / Phase 3 正是冲它们去的,见 §8。

---

## 7. 风险与权衡

- **行数翻倍**:`FairShareWindow` 行数最多 ×2。量级仍小(账号数 × bucket 数 × 卡数 × 2),可接受。
- **周默认预算不准**:早期窗口可能偏宽松 → 与现状同性质(偏宽松不误伤),由 ② / ③ 收敛。
- **两窗 reset 抖动**:上游 reset 时间抖动时 `syncWindow` 的 60s 容差沿用,避免频繁清零。
- **取 min 的体验**:血条会显示更紧的那个窗口,可能让用户看到「周 7%」而 5h 还很满——这是**正确**的(周才是真约束),tooltip 已说明。

---

## 8. 后续阶段(Phase 2 / Phase 3 设计)

Phase 1 把「窗口」修对了,但**预算分母**仍是估算。这两阶段冲的是估算本身。两者可独立上线,Phase 3 落地后 Phase 2 自然被吸收(见 §8.2 末)。

### 8.1 Phase 2:带外用量修正(out-of-band)

**问题**。`perCard` 只累加**经代理**的请求。若同一个号还被**代理外**使用(本人手动用、别的产品线、别的工具),上游 fraction 会掉得比我们记的 `trackedUsed = Σ perCard` 更快。

**先厘清偏差方向(诚实)**。当前 `budget = trackedUsed/(1−f)` 反推:有带外时,它把账号**估小**(因为分子只含我方用量),于是给卡的份额也偏小 → 结果是**过度保守(利用率低)**,而**不是**会引发 429。换言之,带外偏差的方向是「安全但浪费」。所以 Phase 2 的收益是**还卡以应得份额(提利用率)**,不是防 429——这点要说清,别夸大。

**唯一会真出问题的子情形**:撞 429 时 `confirmBudget` 把 `budget` 钉死成当时的 `trackedUsed`。若那次 429 主要由带外用量触发,`budget` 会被钉得过低,**下个窗口**所有卡份额被压扁(虽有 ② 只升不降逐步回弹,但首段窗口偏紧)。Phase 2 主要救这个。

**设计**。引入「带外已用」推断,作为账号级一个量:

```
trackedUsed   = Σ perCard            // 我方实测
impliedUsed   = (1 − f) × budget     // 上游 fraction 隐含的总消耗
outOfBand     = clamp0(impliedUsed − trackedUsed)
```

两处用它:
1. **confirmBudget 修正**(关键):429 时不再 `budget = trackedUsed`,而是 `budget = trackedUsed + outOfBand`(把带外那部分也算进账号真实预算)。这样钉出来的是**账号真预算**,不是「我方那一刀」。
2. **可用份额扣减**(可选):分账时账号「可分给我方卡」的预算 = `budget − outOfBand`(带外吃掉的不许我方卡再分),再按 weight 切。避免我方卡把已被带外吃掉的额度重复分配。

**存储**。`outOfBand` 是账号+bucket+窗口级派生量,可不持久化(每次由 `budget` 与最近 `lastFraction` 现算);或在 `WindowState` 加一个 `lastImpliedUsed` 缓存。

**风险**。`f` 粒度粗(如 Google 20% 台阶)→ `outOfBand` 抖动。对策:仅在 `f ≤ 0.9`(已过宽松区)才启用修正;`outOfBand` 取 EWMA 平滑。

### 8.2 Phase 3:换框架到 fraction 空间(去绝对预算)

**动机**。Phase 1/2 之后,分母仍是一个「猜出来的绝对预算 budget」,带着只升不降的乐观 ratchet。但**上游已经直接告诉我们账号 remaining fraction `f`**——这是真值。既然真值在手,就不该再绕一圈去猜绝对 budget 再做减法。

**核心重构**。完全在 fraction 空间做公平判定,**不需要 budget**:

```
e_i        = weight_i / ACCOUNT_SHARE_CAPACITY      // 卡 i 的应得份额(账号占比)
share_i    = cardUsed_i / trackedUsed               // 卡 i 占「我方已用」的比例(实测)
c_i        = (1 − f) × share_i                      // 卡 i 消耗掉的「账号占比」
份额剩余_i  = clamp01(1 − c_i / e_i)                 // 用超应得份额→趋 0
allowed_i  = c_i < e_i  (且账号还有余量 f > 0)
```

要点:
- **不再有 `estimatedBudget`、`DEFAULT_BUDGETS`、`updateBudgetEstimate` 的只升不降 ratchet** —— 全删。fairness 只依赖三个量:上游 `f`(真值)、`cardUsed_i`(实测)、`weight`(配置)。
- **「压力闸」语义**:`f` 高(账号空)→ `c_i` 小 → 谁都不拦,自动等价今天的「≥90% 放行」。只有账号被用紧(`f` 低)、且某卡消耗占比超过它的应得份额时才拦——这正是「公平」该有的样子。
- **数值连续性**:在「无带外、budget 估得准」的理想情形下,本框架与现公式给出**相同**份额数字(已验算),所以是平滑替换,不是行为突变。
- **带外被自动吸收**:`c_i = (1−f)×share_i` 用的是真 `f`,带外消耗已包含在 `(1−f)` 里,按 `share_i` 只把**我方**消耗归到卡上——Phase 2 的修正在这个框架里**天然成立**,无需单独逻辑。故 Phase 3 落地后 §8.1 的显式修正可移除。

**仍保留**:weighted-token 计量(`cardUsed_i` 仍是加权)、双窗口取 min(每窗口各算 `f` 与 `share`)、5h/周对齐。

**风险 / 代价**:
- 这是 `FairShareTracker` 的**主体重写**(数据结构从「budget+perCard」简化为「perCard share + 最近 f」),`checkFairShare/getCardQuotaFractions/持久化` 全改;中风险,需独立一轮 + 全量回归。
- `share_i` 在 `trackedUsed→0`(窗口初期)时不稳定 → 初期回落「全 100%/放行」,与现状宽松一致。
- 依赖上游 `f` 的可得性与粒度;`f` 缺失的极早期沿用「放行」。

**建议时机**:Phase 1 上线、观察「份额 vs 实际 429」吻合度后再决定。若 Phase 1+2 已足够准,Phase 3 属「架构更干净」的锦上添花,可缓。
