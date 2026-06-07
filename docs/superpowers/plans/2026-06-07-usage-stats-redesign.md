# 用量与剩余可视化重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「用量与剩余」做成分层、图表化、可折叠的看板,统一服务端权重与客户端省钱价到单一定价源。

**Architecture:** 一张 `packages/shared/src/pricing.json` 当唯一定价源 → 服务端 import 派生 fair-share 权重、客户端 `go:embed` 算省钱。运营后台(web)用 shadcn:状态甜甜圈 + 水位分布直方图 + 绑定卡折叠手风琴。客户端(bcai-wails)Dashboard 加用量趋势图、省钱价按家族折算。

**Tech Stack:** TS/NestJS(api)+ Next/React/shadcn/recharts(web)+ Go/Wails/React(客户端)+ packages/shared(TS)。测试:vitest(api)、go test(客户端)、playwright(视觉)。

参照设计:`docs/superpowers/specs/2026-06-07-usage-stats-redesign-design.md`。

---

## 文件结构(创建/修改一览)

- **packages/shared**:`src/pricing.json`(新,唯一源)、`src/pricing.ts`(新,派生 PRICING/QUOTA_WEIGHTS)、`src/index.ts`(改,re-export)、`tsconfig.json`(改,resolveJsonModule)、`package.json`(改,build 拷 json 到 dist)。
- **apps/api**:`src/token-server/fair-share-tracker.ts`(改,QUOTA_WEIGHTS 从 @gfa/shared)、`src/remote-stats/remote-stats.service.ts`(改,distribution + windowWeightedUsed 透传)、`src/lease-core/lease-service.ts`(改,getBoundCardsForAccount 加 windowWeightedUsed)、对应 `__tests__/*`。
- **scripts**:`scripts/sync-pricing.mjs`(新,拷 pricing.json → 客户端)。
- **apps/bcai-wails**:`pricing.json`(新,sync 生成)、`pricing_price.go`(新,embed+查价)、`usage_stats.go`(改,AddTokens 带 family)、各 AddTokens 调用点(改)、`frontend/src/stores/useAppStore.ts`(改,加 daily/hourly/chartMode)、`frontend/src/components/UsageTrendChart.tsx`(新)、`frontend/src/pages/DashboardPage.tsx`(改,插图)。
- **apps/web**:`.../usage-stats/page.tsx`(改)、新增 `usage-stats/ProviderSupplyOverview.tsx`、`ModelDistributionChart.tsx`、`BoundCardAccordion.tsx`、`distribution.ts`(纯函数 + 测试)。

---

## Phase 0 — packages/shared 定价单一源

### Task 0.1: 定价 JSON + 派生模块

**Files:**
- Create: `packages/shared/src/pricing.json`
- Create: `packages/shared/src/pricing.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/tsconfig.json`
- Modify: `packages/shared/package.json`

- [ ] **Step 1: 写 pricing.json(唯一源)**

`packages/shared/src/pricing.json`:
```json
{
  "claude": { "inputPerM": 3, "outputPerM": 15, "cacheReadPerM": 0.30 },
  "gemini": { "inputPerM": 1.25, "outputPerM": 10, "cacheReadPerM": 0.3125 },
  "gpt": { "inputPerM": 1.25, "outputPerM": 10, "cacheReadPerM": 0.125 }
}
```

- [ ] **Step 2: 写 pricing.ts(派生权重)**

`packages/shared/src/pricing.ts`:
```ts
import pricingData from "./pricing.json";

export type FamilyPrice = { inputPerM: number; outputPerM: number; cacheReadPerM: number };
export type Family = "claude" | "gemini" | "gpt";

/** 单一真实定价源(美元/百万 token)。改价只改 pricing.json。 */
export const PRICING: Record<Family, FamilyPrice> = pricingData as Record<Family, FamilyPrice>;

/** fair-share 相对权重 = 定价比值(input 归一为 1)。 */
export const QUOTA_WEIGHTS: Record<Family, { input: number; output: number; cache: number }> =
  Object.fromEntries(
    (Object.entries(PRICING) as [Family, FamilyPrice][]).map(([fam, p]) => [
      fam,
      { input: 1, output: p.outputPerM / p.inputPerM, cache: p.cacheReadPerM / p.inputPerM },
    ]),
  ) as Record<Family, { input: number; output: number; cache: number }>;
```

- [ ] **Step 3: index.ts re-export**

在 `packages/shared/src/index.ts` 末尾追加:
```ts
export { PRICING, QUOTA_WEIGHTS, type Family, type FamilyPrice } from "./pricing";
```

- [ ] **Step 4: tsconfig 开 resolveJsonModule**

`packages/shared/tsconfig.json` 的 `compilerOptions` 加:
```json
    "resolveJsonModule": true,
    "esModuleInterop": true,
```

- [ ] **Step 5: build 脚本把 json 拷到 dist(跨平台 node)**

`packages/shared/package.json` 的 `build` 改为:
```json
    "build": "tsc -p tsconfig.json && node -e \"require('fs').copyFileSync('src/pricing.json','dist/pricing.json')\"",
```

- [ ] **Step 6: 构建 shared,确认 dist 有 pricing.json**

Run: `pnpm --filter @gfa/shared build && ls packages/shared/dist/pricing.json`
Expected: 构建无错,`dist/pricing.json` 存在。

- [ ] **Step 7: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): single pricing source + derived quota weights"
```

---

## Phase 1 — apps/api

### Task 1.1: fair-share 权重改用共享源(并修订现有测试)

**Files:**
- Modify: `apps/api/src/token-server/fair-share-tracker.ts`
- Test: `apps/api/src/token-server/__tests__/fair-share-tracker.spec.ts`

- [ ] **Step 1: 改测试期望值(新权重:gemini 输出 8、gpt 输出 8/缓存 0.10)**

把 `fair-share-tracker.spec.ts` 顶部「weightedCost」三例改成:
```ts
  it("gemini: 缓存不再被 input+cache 双算(取真实定价比值)", () => {
    // gross input 180(含 80 cached), output 20, cached 80;权重 {in1,out8,cache0.25}
    // netInput=100 → 100*1 + 20*8 + 80*0.25 = 100 + 160 + 20 = 280
    expect(FairShareTracker.weightedCost("antigravity-gemini", 180, 20, 80)).toBe(280);
  });

  it("gpt/codex: 输出 8×、缓存 0.10(真实定价比值)", () => {
    // gross input 17056(含 16000 cached), output 28;权重 {in1,out8,cache0.10}
    // netInput=1056 → 1056*1 + 28*8 + 16000*0.10 = 1056 + 224 + 1600 = 2880
    expect(FairShareTracker.weightedCost("codex-gpt", 17056, 28, 16000)).toBe(2880);
  });

  it("claude: 输出 5×、cache_read 0.10(不变)", () => {
    // netInput=150 → 150*1 + 10*5 + 80*0.10 = 150 + 50 + 8 = 208
    expect(FairShareTracker.weightedCost("anthropic-claude", 230, 10, 80)).toBe(208);
  });
```
(最后一例「cached>input」保持不变:`weightedCost("antigravity-gemini",50,0,80)` 仍 `=20`,因 gemini.cache 仍 0.25。)

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm --filter @gfa/api exec vitest run src/token-server/__tests__/fair-share-tracker.spec.ts`
Expected: gemini/gpt 两例 FAIL(现得 200/1140,期望 280/2880)。

- [ ] **Step 3: 用共享权重替换硬编码**

`fair-share-tracker.ts`:删掉本地 `export const QUOTA_WEIGHTS = {...}` 整块,改为:
```ts
import { QUOTA_WEIGHTS } from "@gfa/shared";

export { QUOTA_WEIGHTS };
```
(保留 `import { bucketFamily } from "../lease-core/product-bucket";` 与 `weightedCost` 内 `QUOTA_WEIGHTS[bucketFamily(bucket)] || QUOTA_WEIGHTS.gemini` 不变。)

- [ ] **Step 4: 构建 shared 后跑测试,确认通过**

Run: `pnpm --filter @gfa/shared build && pnpm --filter @gfa/api exec vitest run src/token-server/__tests__/fair-share-tracker.spec.ts`
Expected: PASS。

- [ ] **Step 5: 加一条派生断言(守住单一源)**

在该 spec 末尾追加:
```ts
import { QUOTA_WEIGHTS } from "@gfa/shared";
describe("QUOTA_WEIGHTS 派生自定价源", () => {
  it("claude 5/0.10、gemini 8/0.25、gpt 8/0.10", () => {
    expect(QUOTA_WEIGHTS.claude).toMatchObject({ input: 1, output: 5, cache: 0.1 });
    expect(QUOTA_WEIGHTS.gemini).toMatchObject({ input: 1, output: 8, cache: 0.25 });
    expect(QUOTA_WEIGHTS.gpt).toMatchObject({ input: 1, output: 8, cache: 0.1 });
  });
});
```

- [ ] **Step 6: 跑全 token-server 套件 + tsc**

Run: `pnpm --filter @gfa/api exec vitest run src/token-server && pnpm --filter @gfa/api exec tsc -p tsconfig.json --noEmit`
Expected: 全 PASS、tsc 0 错。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/token-server/fair-share-tracker.ts apps/api/src/token-server/__tests__/fair-share-tracker.spec.ts
git commit -m "refactor(api): derive fair-share weights from shared pricing source"
```

### Task 1.2: rollupProviderStats 加 distribution

**Files:**
- Modify: `apps/api/src/remote-stats/remote-stats.service.ts`
- Test: `apps/api/src/remote-stats/__tests__/remote-stats.service.spec.ts`

- [ ] **Step 1: 写失败测试(按档计数)**

在 `remote-stats.service.spec.ts` 的 `describe("rollupProviderStats")` 内追加:
```ts
  it("emits per-model account distribution by water band", () => {
    const r = rollupProviderStats("antigravity", {
      ...antigravityStatus,
      quota: { accounts: [
        { id: 1, enabled: true, quotaStatus: "ok", modelQuotaFractions: { "gemini-2.5-pro": 0.03 } }, // exhausted
        { id: 2, enabled: true, quotaStatus: "ok", modelQuotaFractions: { "gemini-2.5-pro": 0.15 } }, // warn
        { id: 3, enabled: true, quotaStatus: "ok", modelQuotaFractions: { "gemini-2.5-pro": 0.40 } }, // low
        { id: 4, enabled: true, quotaStatus: "ok", modelQuotaFractions: { "gemini-2.5-pro": 0.80 } }, // healthy
        { id: 5, enabled: true, quotaStatus: "ok", modelQuotaFractions: {} },                          // noData
      ] },
    });
    const g = r.models.find((m) => m.key === "gemini-2.5-pro")!;
    expect(g.distribution).toEqual({ exhausted: 1, warn: 1, low: 1, healthy: 1, noData: 1 });
  });
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm --filter @gfa/api exec vitest run src/remote-stats/__tests__/remote-stats.service.spec.ts`
Expected: FAIL（`distribution` undefined）。

- [ ] **Step 3: 实现 distribution**

`remote-stats.service.ts`:在 `ProviderModelStat` 接口加字段:
```ts
  distribution: { exhausted: number; warn: number; low: number; healthy: number; noData: number };
```
在 `rollupProviderStats` 的 model map 内,计算分布(复用已有 `getModelQuotaFraction`):
```ts
    const distribution = { exhausted: 0, warn: 0, low: 0, healthy: 0, noData: 0 };
    for (const acc of enabledAccounts) {
      const f = getModelQuotaFraction(acc, m.key);
      if (f === null || f < 0) distribution.noData++;
      else if (f < 0.05) distribution.exhausted++;
      else if (f < 0.20) distribution.warn++;
      else if (f < 0.50) distribution.low++;
      else distribution.healthy++;
    }
```
并在返回对象里加 `distribution,`。

- [ ] **Step 4: 运行,确认通过**

Run: `pnpm --filter @gfa/api exec vitest run src/remote-stats/__tests__/remote-stats.service.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/remote-stats
git commit -m "feat(api): per-model account water-band distribution in stats rollup"
```

### Task 1.3: 绑定卡 windowWeightedUsed(实测)

**Files:**
- Modify: `apps/api/src/token-server/fair-share-tracker.ts`
- Modify: `apps/api/src/lease-core/lease-service.ts`
- Modify: `apps/api/src/remote-stats/remote-stats.service.ts`
- Test: `apps/api/src/token-server/__tests__/fair-share-tracker.spec.ts`, `apps/api/src/remote-stats/__tests__/remote-stats.service.spec.ts`

- [ ] **Step 1: 写失败测试(tracker 暴露每卡本窗口已用)**

在 `fair-share-tracker.spec.ts` 的「SQL persistence」之外、`describe("FairShareTracker SQL persistence")` 前加新块:
```ts
describe("FairShareTracker.getCardWindowUsed", () => {
  it("sums a card's weighted usage across buckets in the current window", () => {
    const t = new FairShareTracker({
      getAccountPlanType: () => "pro", getBoundCardIds: () => [], getCardWeight: () => 1,
      accountShareCapacity: 8, now: () => 1_700_000_000_000,
    });
    t.recordUsage(1, "c1", "codex-gpt", 100, 0, 0); // 100
    t.recordUsage(1, "c1", "anthropic-claude", 0, 10, 0); // 10*5=50
    expect(t.getCardWindowUsed(1, "c1")).toBe(150);
    expect(t.getCardWindowUsed(1, "absent")).toBe(0);
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm --filter @gfa/api exec vitest run src/token-server/__tests__/fair-share-tracker.spec.ts`
Expected: FAIL（`getCardWindowUsed` 不存在）。

- [ ] **Step 3: 实现 getCardWindowUsed**

`fair-share-tracker.ts` 在 `getBucketStateForTesting` 附近加公有方法:
```ts
  /** 一张卡本 5h 窗口的加权已用(跨该账号所有 bucket 求和,实测)。 */
  getCardWindowUsed(accountId: number, cardId: string): number {
    const bucketMap = this.trackers.get(accountId);
    if (!bucketMap) return 0;
    const now = this.nowFn();
    let total = 0;
    for (const tracker of bucketMap.values()) {
      this.ensureWindow(tracker, now);
      total += tracker.perCard.get(cardId) || 0;
    }
    return total;
  }
```

- [ ] **Step 4: getBoundCardsForAccount 带上 windowWeightedUsed**

`lease-service.ts` 的 `getBoundCardsForAccount` 返回类型加 `windowWeightedUsed: number;`,map 内加:
```ts
        windowWeightedUsed: this.fairShareTracker?.getCardWindowUsed(accountId, id) || 0,
```

- [ ] **Step 5: dashboard 类型与测试**

`remote-stats.service.ts` 的 `DashboardProvider.getBoundCardsForAccount` 返回类型加 `windowWeightedUsed: number;`(`decorateCard` 用 `...card` 已自动透传,无需改逻辑)。
在 `remote-stats.service.spec.ts` 的 dashboard 测试里,给 codex 的 `getBoundCardsForAccount` 桩卡加 `windowWeightedUsed: 1500`,并断言:
```ts
    expect(card.windowWeightedUsed).toBe(1500);
```

- [ ] **Step 6: 运行两套 spec + tsc,确认通过**

Run: `pnpm --filter @gfa/api exec vitest run src/token-server src/remote-stats src/lease-core && pnpm --filter @gfa/api exec tsc -p tsconfig.json --noEmit`
Expected: 全 PASS、tsc 0 错。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): expose per-card window weighted usage on dashboard"
```

---

## Phase 2 — apps/web(全 shadcn)

> 约定:所有自定义可视化(甜甜圈/直方图/sparkline)用纯 div+SVG 包在 shadcn `Card` 里。需要的 shadcn 组件若缺,用 `npx shadcn@latest add collapsible`(Collapsible)等补。

### Task 2.1: 类型扩展 + 分布纯函数

**Files:**
- Create: `apps/web/src/app/console/(dashboard)/usage-stats/distribution.ts`
- Test: `apps/web/src/app/console/(dashboard)/usage-stats/distribution.test.ts`
- Modify: `apps/web/src/app/console/(dashboard)/usage-stats/page.tsx`(`ModelStat` 类型加 distribution)

- [ ] **Step 1: 写直方图档开关纯函数的失败测试**

`distribution.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { BANDS, visibleBars, type Distribution } from "./distribution";

const d: Distribution = { exhausted: 3, warn: 7, low: 11, healthy: 24, noData: 241 };

describe("visibleBars", () => {
  it("默认隐藏 noData,返回其余档", () => {
    const bars = visibleBars(d, new Set(["noData"]));
    expect(bars.map((b) => b.key)).toEqual(["exhausted", "warn", "low", "healthy"]);
    expect(bars.find((b) => b.key === "healthy")!.max).toBe(24); // 隐藏 noData 后最大=24
  });
  it("全显时 max=最大档(noData 241)", () => {
    const bars = visibleBars(d, new Set());
    expect(Math.max(...bars.map((b) => b.max))).toBe(241);
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm --filter web exec vitest run src/app/console/\(dashboard\)/usage-stats/distribution.test.ts`
Expected: FAIL（模块不存在)。
> 注:web 若无 vitest,改用 `pnpm --filter web exec tsc` 验证类型,并把该测试移到 api 风格的纯函数测试目录;若无测试器则此函数仍单列文件便于审。确认 web 测试器:`grep -q vitest apps/web/package.json`。

- [ ] **Step 3: 实现 distribution.ts**

```ts
export type Distribution = { exhausted: number; warn: number; low: number; healthy: number; noData: number };
export type BandKey = keyof Distribution;

export const BANDS: { key: BandKey; label: string; color: string }[] = [
  { key: "exhausted", label: "耗尽", color: "#ef4444" },
  { key: "warn", label: "紧张", color: "#f59e0b" },
  { key: "low", label: "偏低", color: "#eab308" },
  { key: "healthy", label: "健康", color: "#22c55e" },
  { key: "noData", label: "无数据", color: "#cbd5e1" },
];

export function visibleBars(d: Distribution, hidden: Set<BandKey>) {
  const shown = BANDS.filter((b) => !hidden.has(b.key));
  const max = Math.max(1, ...shown.map((b) => d[b.key]));
  return shown.map((b) => ({ key: b.key, label: b.label, color: b.color, count: d[b.key], max }));
}
```

- [ ] **Step 4: 运行,确认通过 + page.tsx 类型扩展**

`page.tsx` 的 `type ModelStat` 加:
```ts
  distribution: import("./distribution").Distribution;
```
Run: `pnpm --filter web lint`
Expected: tsc 0 错(+ 若有 vitest,测试 PASS)。

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/console/(dashboard)/usage-stats/distribution.ts" "apps/web/src/app/console/(dashboard)/usage-stats/distribution.test.ts" "apps/web/src/app/console/(dashboard)/usage-stats/page.tsx"
git commit -m "feat(web): distribution model + band-toggle helper"
```

### Task 2.2: ProviderSupplyOverview(状态甜甜圈)

**Files:**
- Create: `apps/web/src/app/console/(dashboard)/usage-stats/ProviderSupplyOverview.tsx`

- [ ] **Step 1: 写组件(甜甜圈 conic-gradient + 圆心 可用 X/N + sparkline)**

```tsx
"use client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BANDS, type Distribution } from "./distribution";

type ModelLike = { key: string; displayName: string; available: number; poolSize: number; distribution: Distribution };

function Donut({ d }: { d: Distribution }) {
  const total = BANDS.reduce((a, b) => a + d[b.key], 0) || 1;
  let acc = 0;
  const stops = BANDS.map((b) => {
    const start = (acc / total) * 360; acc += d[b.key];
    const end = (acc / total) * 360;
    return `${b.color} ${start}deg ${end}deg`;
  }).join(",");
  return <div className="size-14 rounded-full" style={{ background: `conic-gradient(${stops})` }} />;
}

export function ProviderSupplyOverview({ models }: { models: ModelLike[] }) {
  const sorted = [...models].sort((a, b) => a.available - b.available);
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">各模型供给(账号水位分布)</CardTitle></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((m) => (
          <div key={m.key} className="flex items-center gap-3 rounded-lg border p-3">
            <div className="relative shrink-0">
              <Donut d={m.distribution} />
              <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold tabular-nums">
                {m.available}/{m.poolSize}
              </span>
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">{m.displayName}</div>
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                {BANDS.filter((b) => b.key !== "noData" && m.distribution[b.key] > 0).map((b) => (
                  <span key={b.key}><span className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: b.color }} />{m.distribution[b.key]}</span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: tsc 验证**

Run: `pnpm --filter web lint`
Expected: 0 错。

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/console/(dashboard)/usage-stats/ProviderSupplyOverview.tsx"
git commit -m "feat(web): provider supply overview with status donuts"
```

### Task 2.3: ModelDistributionChart(直方图 + 档开关)

**Files:**
- Create: `apps/web/src/app/console/(dashboard)/usage-stats/ModelDistributionChart.tsx`

- [ ] **Step 1: 写组件(Toggle chips + 柱子按 visibleBars 重算高度)**

```tsx
"use client";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BANDS, visibleBars, type BandKey, type Distribution } from "./distribution";

export function ModelDistributionChart({ title, distribution }: { title: string; distribution: Distribution }) {
  const [hidden, setHidden] = useState<Set<BandKey>>(new Set(["noData"]));
  const bars = visibleBars(distribution, hidden);
  const toggle = (k: BandKey) => setHidden((prev) => {
    const next = new Set(prev); next.has(k) ? next.delete(k) : next.add(k); return next;
  });
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">{title} · 账号水位分布</CardTitle></CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap gap-2">
          {BANDS.map((b) => (
            <button key={b.key} onClick={() => toggle(b.key)}
              className={`cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium transition ${hidden.has(b.key) ? "opacity-40 line-through" : ""}`}
              style={{ background: `${b.color}22`, color: b.color }}>
              ● {b.label} {distribution[b.key]}
            </button>
          ))}
        </div>
        <div className="flex h-36 items-end gap-3 border-b pb-1">
          {bars.map((b) => (
            <div key={b.key} className="flex flex-1 flex-col items-center justify-end gap-1">
              <span className="text-sm font-bold tabular-nums" style={{ color: b.color }}>{b.count}</span>
              <div className="w-full rounded-t" style={{ height: `${(b.count / b.max) * 100}%`, minHeight: 4, background: b.color }} />
              <span className="text-[10px] text-muted-foreground">{b.label}</span>
            </div>
          ))}
          {bars.length === 0 && <div className="flex-1 py-8 text-center text-xs text-muted-foreground">所有档已隐藏</div>}
        </div>
        <div className="mt-2 text-[10px] text-muted-foreground">
          点上方标签开关档。<Badge variant="outline" className="ml-1">默认隐藏无数据</Badge>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: tsc 验证 + commit**

Run: `pnpm --filter web lint`
Expected: 0 错。
```bash
git add "apps/web/src/app/console/(dashboard)/usage-stats/ModelDistributionChart.tsx"
git commit -m "feat(web): model distribution histogram with band toggles"
```

### Task 2.4: BoundCardAccordion(折叠手风琴 + 只看告警)

**Files:**
- Create: `apps/web/src/app/console/(dashboard)/usage-stats/BoundCardAccordion.tsx`
- 可能需要:`npx shadcn@latest add collapsible`(若 `@/components/ui/collapsible` 不存在)

- [ ] **Step 1: 确认/安装 Collapsible**

Run: `ls apps/web/src/components/ui/collapsible.tsx 2>/dev/null || (cd apps/web && npx shadcn@latest add collapsible)`
Expected: 文件存在。

- [ ] **Step 2: 写组件(账号折叠 + 只看告警开关 + 卡表)**

```tsx
"use client";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ChevronRightIcon } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type FairShare = Record<string, { fraction: number; resetAt: number }>;
type Card_ = { id: string; name: string; weight: number; windowWeightedUsed: number; totalTokensUsed: number; totalRequests: number; fairShare: FairShare };
type Account = { id: number; email: string; planType: string; quotaStatus: string; boundCards: Card_[] };

function minFraction(fs: FairShare): number | null {
  const v = Object.values(fs).map((f) => f.fraction); return v.length ? Math.min(...v) : null;
}
function barColor(pct: number) { return pct >= 50 ? "#22c55e" : pct >= 20 ? "#f59e0b" : "#ef4444"; }

export function BoundCardAccordion({ accounts }: { accounts: Account[] }) {
  const [warnOnly, setWarnOnly] = useState(false);
  const shown = accounts.filter((a) => !warnOnly || a.boundCards.some((c) => { const f = minFraction(c.fairShare); return f !== null && f < 0.2; }));
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">绑定卡明细</CardTitle>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">只看告警账号 <Switch checked={warnOnly} onCheckedChange={setWarnOnly} /></label>
      </CardHeader>
      <CardContent className="space-y-2">
        {shown.length === 0 && <div className="py-4 text-center text-xs text-muted-foreground">无符合条件的账号</div>}
        {shown.map((a) => {
          const worst = Math.min(100, ...a.boundCards.map((c) => { const f = minFraction(c.fairShare); return f === null ? 100 : Math.round(f * 100); }));
          return (
            <Collapsible key={a.id} className="rounded-lg border">
              <CollapsibleTrigger className="flex w-full items-center gap-2 p-3 text-sm [&[data-state=open]>svg]:rotate-90">
                <ChevronRightIcon className="size-3 text-muted-foreground transition" />
                <span className="truncate font-medium">{a.email || `账号 #${a.id}`}</span>
                {a.planType && <Badge variant="secondary">{a.planType}</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">{a.boundCards.length} 卡 · 份额最紧 {worst}%</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="border-t px-3 py-2">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>卡</TableHead><TableHead className="text-center">权重</TableHead>
                      <TableHead className="text-right">本窗口已用</TableHead><TableHead className="text-right">累计 Token</TableHead>
                      <TableHead className="w-32">份额剩余 <Badge variant="outline" className="ml-1 text-[9px]">估算</Badge></TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {a.boundCards.map((c) => {
                        const f = minFraction(c.fairShare); const pct = f === null ? null : Math.round(f * 100);
                        return (
                          <TableRow key={c.id}>
                            <TableCell className="max-w-[140px] truncate font-medium">{c.name || c.id}</TableCell>
                            <TableCell className="text-center"><Badge variant="secondary">×{c.weight}</Badge></TableCell>
                            <TableCell className="text-right tabular-nums">{Math.round(c.windowWeightedUsed).toLocaleString()}</TableCell>
                            <TableCell className="text-right tabular-nums">{c.totalTokensUsed.toLocaleString()}</TableCell>
                            <TableCell>{pct === null ? <span className="text-xs text-muted-foreground">—</span> : (
                              <div className="flex items-center gap-2"><div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, background: barColor(pct) }} /></div><span className="w-8 text-right text-xs tabular-nums">{pct}%</span></div>
                            )}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: 确认 Switch 存在(缺则 `npx shadcn@latest add switch`)+ tsc**

Run: `ls apps/web/src/components/ui/switch.tsx 2>/dev/null || (cd apps/web && npx shadcn@latest add switch); pnpm --filter web lint`
Expected: 0 错。

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/console/(dashboard)/usage-stats/BoundCardAccordion.tsx" apps/web/src/components/ui
git commit -m "feat(web): collapsible bound-card accordion with warn-only filter"
```

### Task 2.5: 接进 page.tsx,移除旧表/旧平铺

**Files:**
- Modify: `apps/web/src/app/console/(dashboard)/usage-stats/page.tsx`

- [ ] **Step 1: 用新组件替换旧 ProviderBoard 的「各模型供给」表与 AccountDetailCard 平铺**

在 `ProviderBoard` 内:用 `<ProviderSupplyOverview models={p.models} />` 替换原 `各模型供给` 表(`ModelSupplyRow` 相关 JSX),保留账号块改为 `<BoundCardAccordion accounts={accounts} />`;为每个 model 提供「点开看分布直方图」:可用 shadcn `Dialog` 或就地展开 `<ModelDistributionChart>`(MVP:在 overview 卡下放一个被点选 model 的 `ModelDistributionChart`)。删除 `ModelSupplyRow`、`AccountDetailCard`、`WaterBar`、`FrequencyBars`、`Sparkline`(若被新组件取代)。导入新组件。

- [ ] **Step 2: tsc + 构建**

Run: `pnpm --filter web lint`
Expected: 0 错(清理未用 import)。

- [ ] **Step 3: 真实栈 playwright 视觉验证**

按 spec「数据来源」起 api+web、登录 admin@gfa.local/admin123 → `/console/usage-stats`,确认:甜甜圈渲染、点开直方图档可开关、账号折叠 +「只看告警」生效、份额带「估算」标签。截图留档。

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/console/(dashboard)/usage-stats/page.tsx"
git commit -m "feat(web): wire redesigned usage-stats page (donut + histogram + accordion)"
```

---

## Phase 3 — apps/bcai-wails(客户端,复用现有组件)

### Task 3.1: 定价同步脚本 + go:embed

**Files:**
- Create: `scripts/sync-pricing.mjs`
- Create: `apps/bcai-wails/pricing.json`(由脚本生成)
- Create: `apps/bcai-wails/pricing_price.go`

- [ ] **Step 1: 写 sync 脚本**

`scripts/sync-pricing.mjs`:
```js
import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
copyFileSync(resolve(root, "packages/shared/src/pricing.json"), resolve(root, "apps/bcai-wails/pricing.json"));
console.log("[sync-pricing] copied pricing.json → apps/bcai-wails/");
```

- [ ] **Step 2: 跑脚本生成客户端 pricing.json**

Run: `node scripts/sync-pricing.mjs && cat apps/bcai-wails/pricing.json`
Expected: 客户端 `pricing.json` 与 shared 内容一致。

- [ ] **Step 3: 写 Go embed + 查价**

`apps/bcai-wails/pricing_price.go`:
```go
package main

import (
	_ "embed"
	"encoding/json"
)

//go:embed pricing.json
var pricingJSON []byte

type familyPrice struct {
	InputPerM     float64 `json:"inputPerM"`
	OutputPerM    float64 `json:"outputPerM"`
	CacheReadPerM float64 `json:"cacheReadPerM"`
}

var familyPricing = func() map[string]familyPrice {
	m := map[string]familyPrice{}
	_ = json.Unmarshal(pricingJSON, &m)
	return m
}()

// priceFor 返回某家族 输入/输出 美元每百万 token。未知家族回退 gemini。
func priceFor(family string) (inPerM, outPerM float64) {
	p, ok := familyPricing[family]
	if !ok {
		p = familyPricing["gemini"]
	}
	return p.InputPerM, p.OutputPerM
}
```

- [ ] **Step 4: 编译确认**

Run: `cd apps/bcai-wails && go build ./...`
Expected: 编译通过。

- [ ] **Step 5: 在 package.json 挂 predev/prebuild + Commit**

根 `package.json` 的 `dev:setup` 末尾或新增 `presync`:在 `"dev"` 前确保同步。最简:给根加脚本 `"sync:pricing": "node scripts/sync-pricing.mjs"`,并在 `db:generate` 同级文档注明 CI 跑 `node scripts/sync-pricing.mjs && git diff --exit-code`。
```bash
git add scripts/sync-pricing.mjs apps/bcai-wails/pricing.json apps/bcai-wails/pricing_price.go package.json
git commit -m "feat(client): embed shared pricing via sync script"
```

### Task 3.2: 省钱价按家族(go test TDD)

**Files:**
- Modify: `apps/bcai-wails/usage_stats.go`
- Modify: 调用点 `claude_proxy.go`、`proxy_tokens.go`、`proxy_generation.go`(传 family)
- Test: `apps/bcai-wails/usage_stats_test.go`(新)

- [ ] **Step 1: 写失败 go 测试**

`apps/bcai-wails/usage_stats_test.go`:
```go
package main

import "testing"

func TestAddTokensSavedMoneyPerFamily(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}
	s.AddTokens("claude", 1_000_000, 200_000, 0) // 1M*$3 + 0.2M*$15 = 3 + 3 = 6
	if got := s.GetTodayRecord().SavedMoneyUSD; got != 6 {
		t.Fatalf("claude saved = %v, want 6", got)
	}
	s.AddTokens("gemini", 1_000_000, 0, 0) // +1M*$1.25 = +1.25 → 7.25
	if got := s.GetTodayRecord().SavedMoneyUSD; got != 7.25 {
		t.Fatalf("after gemini saved = %v, want 7.25", got)
	}
}
```

- [ ] **Step 2: 运行,确认失败(签名不符)**

Run: `cd apps/bcai-wails && go test -run TestAddTokensSavedMoneyPerFamily ./...`
Expected: 编译失败(AddTokens 参数数不符)。

- [ ] **Step 3: 改 AddTokens 签名 + 增量累计省钱**

`usage_stats.go` 把 `AddTokens(input, output, cached int64)` 改为:
```go
func (s *UsageStatsStore) AddTokens(family string, input, output, cached int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.getToday()
	rec.InputTokens += input
	rec.OutputTokens += output
	rec.CachedTokens += cached
	inP, outP := priceFor(family)
	rec.SavedMoneyUSD += float64(input)/1_000_000.0*inP + float64(output)/1_000_000.0*outP
	hr := s.getHour()
	hr.InputTokens += input
	hr.OutputTokens += output
	s.dirty = true
}
```

- [ ] **Step 4: 改三个调用点传 family**

- `claude_proxy.go:296,317` → `GetUsageStats().AddTokens("claude", details.InputTokens, details.OutputTokens, details.CachedInputTokens)`
- `proxy_tokens.go:129` → 该处服务 antigravity;按当前模型家族传:`GetUsageStats().AddTokens(familyFromModel(model), inputTokens, outputTokens, cachedTokens)`(model 变量为该请求模型;若该作用域无 model,用 `"gemini"` 兜底并加 TODO 注释说明 antigravity 默认 gemini)。
- codex 路径(`proxy_tokens.go` 或 codex 专属上报处)→ `"gpt"`。
若需 `familyFromModel`,加到 `pricing_price.go`:
```go
func familyFromModel(model string) string {
	switch {
	case len(model) >= 6 && model[:6] == "claude":
		return "claude"
	case len(model) >= 3 && (model[:3] == "gpt" || model[:1] == "o"):
		return "gpt"
	default:
		return "gemini"
	}
}
```

- [ ] **Step 5: 跑测试 + 全量 go test**

Run: `cd apps/bcai-wails && go test ./...`
Expected: 新测试 PASS,其余不回归。

- [ ] **Step 6: Commit**

```bash
git add apps/bcai-wails/usage_stats.go apps/bcai-wails/usage_stats_test.go apps/bcai-wails/pricing_price.go apps/bcai-wails/claude_proxy.go apps/bcai-wails/proxy_tokens.go apps/bcai-wails/proxy_generation.go
git commit -m "feat(client): per-family savings from embedded pricing"
```

### Task 3.3: Dashboard 用量趋势图

**Files:**
- Modify: `apps/bcai-wails/frontend/src/stores/useAppStore.ts`
- Create: `apps/bcai-wails/frontend/src/components/UsageTrendChart.tsx`
- Modify: `apps/bcai-wails/frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 1: store 加 daily/hourly/chartMode**

`useAppStore.ts`:`AppState` 接口加:
```ts
  dailyHistory: { date: string; inputTokens: number; outputTokens: number }[]
  hourlyHistory: { hour: string; inputTokens: number; outputTokens: number }[]
  chartMode: string
```
初始值(initialState 区)加 `dailyHistory: [], hourlyHistory: [], chartMode: "daily",`;`refreshStatus` 的 setState 里(today 同处)加:
```ts
        dailyHistory: data.dailyHistory || [],
        hourlyHistory: data.hourlyHistory || [],
        chartMode: data.chartMode || "daily",
```

- [ ] **Step 2: 写 UsageTrendChart(复用 Card,纯 div/SVG,无 recharts)**

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAppStore } from '@/stores/useAppStore'
import { formatTokens } from '@/lib/utils'

export function UsageTrendChart() {
  const { dailyHistory, hourlyHistory, chartMode } = useAppStore()
  const rows = chartMode === 'hourly'
    ? hourlyHistory.map((h) => ({ label: h.hour, input: h.inputTokens, output: h.outputTokens }))
    : [...dailyHistory].reverse().map((d) => ({ label: d.date.slice(5), input: d.inputTokens, output: d.outputTokens }))
  const max = Math.max(1, ...rows.map((r) => r.input + r.output))
  return (
    <Card>
      <CardHeader><CardTitle>用量趋势 · {chartMode === 'hourly' ? '今日(小时)' : '近 7 天'}</CardTitle></CardHeader>
      <CardContent>
        <div className="flex h-28 items-end gap-1.5">
          {rows.map((r, i) => (
            <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1" title={`输入 ${formatTokens(r.input)} · 输出 ${formatTokens(r.output)}`}>
              <div className="flex w-3/5 flex-col justify-end" style={{ height: '100%' }}>
                <div style={{ height: `${(r.input / max) * 100}%`, background: '#60a5fa', borderRadius: '2px 2px 0 0' }} />
                <div style={{ height: `${(r.output / max) * 100}%`, background: '#a78bfa' }} />
              </div>
              <span className="text-[9px] text-[var(--text-muted)]">{r.label}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-4 text-[11px] text-[var(--text-muted)]">
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: '#60a5fa' }} />输入</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: '#a78bfa' }} />输出</span>
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 3: 插进 DashboardPage(省钱卡之后)**

`DashboardPage.tsx`:import `UsageTrendChart`,在 Row 3 省钱卡之后插入 `<UsageTrendChart />`。

- [ ] **Step 4: tsc + commit**

Run: `cd apps/bcai-wails/frontend && npx tsc --noEmit`
Expected: 0 错。
```bash
git add apps/bcai-wails/frontend/src/stores/useAppStore.ts apps/bcai-wails/frontend/src/components/UsageTrendChart.tsx apps/bcai-wails/frontend/src/pages/DashboardPage.tsx
git commit -m "feat(client): usage trend chart on dashboard"
```

---

## 收尾验证(全量)

- [ ] api:`pnpm --filter @gfa/shared build && pnpm --filter @gfa/api test && pnpm --filter @gfa/api exec tsc -p tsconfig.json --noEmit`
- [ ] web:`pnpm --filter web lint`
- [ ] 客户端:`cd apps/bcai-wails && go test ./... && (cd frontend && npx tsc --noEmit)`
- [ ] 一致性:`node scripts/sync-pricing.mjs && git diff --exit-code`(无改动=已同步)
- [ ] 视觉:playwright 真实栈过 usage-stats(web)+ 客户端 Dashboard 截图(如可起客户端)

---

## 自查记录(已核)
- **Spec 覆盖**:定价单一源(Task 0.1)、派生权重(1.1)、distribution(1.2)、windowWeightedUsed(1.3)、甜甜圈(2.2)、直方图档开关(2.1+2.3)、折叠手风琴+只看告警(2.4)、接页(2.5)、客户端 embed/省钱(3.1/3.2)、趋势图(3.3)、实测vs估算标签(2.4 份额「估算」+ 客户端省钱「估算」由 UI 文案体现)。
- **类型一致**:`Distribution`/`BandKey` 跨 2.1/2.2/2.3 一致;`getCardWindowUsed`、`windowWeightedUsed` 跨 1.3 一致;`AddTokens(family,...)` 跨 3.1/3.2 一致。
- **风险**:web 是否有 vitest 决定 distribution.test 跑法(Task 2.1 Step 2 已给回退);客户端 `proxy_tokens.go` family 归属需实现时按实际 model 变量确定(已给 `familyFromModel` 兜底)。
