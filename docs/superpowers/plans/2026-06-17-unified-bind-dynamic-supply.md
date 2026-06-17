# 统一绑定线动态供给 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把客户可见套餐统一成“绑定线席位制”，后台保留动态供给、可配置超卖、首绑优先和无感换号，并让客户端稳定展示“我的席位”和“当前服务账号”血条。

**Architecture:** 购买/授予时把席位权益固化成 `bucketLimits` + `weeklyBucketLimits`，运行时先检查客户固定额度，再按首绑账号、同等级账号、跨等级账号动态选号。客户端不再把账号血条当成客户权益，只展示本卡固定额度和最新 lease 的真实服务账号。

**Tech Stack:** NestJS + Prisma(SQLite) + Vitest；Next.js/React 客户门户和后台；Go/Wails 桌面客户端；pnpm workspace 与 Go 单测。

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `apps/server/src/leasing/plan-catalog/pricing.ts` | 目录选择到价格/config 的纯函数 | 把 `shareUsers` 迁移为 `shareSeats`，绑定线只生成购买意图，不再生成号池线新 config |
| `apps/server/src/leasing/plan-catalog/unified-entitlement.ts` | 新建纯 helper | 解析席位、读取目录里的供给策略、生成固定 5h/周 bucket 上限 |
| `apps/server/src/leasing/plan-catalog/quota-baseline.service.ts` | 新建服务 | 从 `QuotaProfile` 读取 Claude/Codex 学习基准，Antigravity Ultra 用固定值 |
| `apps/server/src/leasing/plan-catalog/*.spec.ts` | 服务端目录测试 | 覆盖席位语义、固定额度、Antigravity 固定基准 |
| `apps/server/src/leasing/account/billing/billing.service.ts` | 客户购买/后台授予入口 | 订单创建前 enrich config，按销售席位预检首绑账号 |
| `apps/server/src/leasing/subscription/subscription-config.ts` | Subscription.config 到 runtime record | 支持 `shareSeats`、`shareCapacity`、`displayBindings`、`assignmentPolicy`、`weeklyBucketLimits` |
| `apps/server/src/leasing/subscription/seat.ts` | 销售席位占用统计 | 从固定 8 份容量改成按产品/等级策略的销售席位容量 |
| `apps/server/src/leasing/subscription/config-fingerprint.ts` | 同配置续费判断 | 指纹改用购买意图：产品、等级、席位、设备，不包含运行时绑定结果和固化额度 |
| `apps/server/src/leasing/subscription/entitlement-sync.service.ts` | 首绑分配和 shadow record 注册 | 写入 `displayBindings`，legacy `bindings` 只做兼容镜像 |
| `apps/server/src/leasing/token-server/access-key-store.ts` | 卡/订阅限额引擎 | 增加 `weeklyBucketLimits` 精确周限额和 public status 输出 |
| `apps/server/src/leasing/lease-core/lease-service.ts` | 三产品 lease 核心 | preferred-dynamic 选号、跨等级 fallback、排序、`poolEnabled` 退出运行时过滤 |
| `apps/server/src/leasing/lease-core/subscription-scheduler.ts` | 订阅优先级接力 | 保留账户多订阅接力，但不承担账号 fallback |
| `apps/server/src/leasing/account/portal/portal.service.ts` | 客户门户 overview | 返回席位标签和本卡 5h/周血条数据 |
| `apps/server/src/leasing/account/card-migration/card-migration.service.ts` | 老卡迁移 | 保留原额度并生成历史席位展示标签 |
| `apps/web/src/lib/account/catalog-pricing.ts` | 客户购买页价格镜像 | 与 server `pricing.ts` 同步 `shareSeats` 语义 |
| `apps/web/src/components/account/catalog-purchase.tsx` | 客户购买页 | 移除客户可见号池线，只展示产品/类型 + `1/2/4/8` 席 |
| `apps/web/src/lib/console/plan-catalog-form.ts` | 后台套餐表单转换 | 加统一供给配置入口：基准、固定/学习来源、每账号可售席位 |
| `apps/web/src/app/(console)/console/(dashboard)/(product)/plan-catalog/*` | 后台套餐配置 UI | 去掉号池售卖入口，增加供给策略编辑 |
| `apps/web/src/app/(console)/console/(dashboard)/(customer)/customers/[id]/grant-subscription-dialog.tsx` | 后台授予 | 只允许统一绑定线席位授予 |
| `apps/app/leaser_status.go` | Wails 统一 leaser 状态 | 提供统一的 card/account quota 状态源 |
| `apps/app/codex_leaser.go`、`apps/app/claude_leaser.go` | 独立 leaser | lease 响应回填主 `accessKeyStatus`，修复 Codex/Claude-only 卡额度展示 |
| `apps/app/frontend/src/lib/quotaDisplay.ts` | 桌面展示 mapper | 生成“我的席位”和“当前服务账号”的 5h/周血条模型 |
| `apps/app/frontend/src/pages/DashboardPage.tsx` | 桌面首页 | 重构额度区，不展示具体额度 token |
| `apps/app/frontend/src/components/BoundAccountsCard.tsx` | 服务账号面板 | 改名为“当前服务账号”，展示最新 lease 真实账号 |

---

## Task 1: 固化席位语义和目录 config 结构

**Files:**
- Modify: `apps/server/src/leasing/plan-catalog/pricing.ts`
- Modify: `apps/server/src/leasing/plan-catalog/pricing.spec.ts`
- Modify: `apps/web/src/lib/account/catalog-pricing.ts`
- Modify: `apps/web/src/test/account/catalog-pricing.test.ts`
- Modify: `apps/web/src/test/account/catalog-order-dialog.test.tsx`

- [ ] **Step 1: 写失败测试**

在 server 和 web 的 pricing 测试中新增同名 case：`shareSeats=2` 必须生成 `weight: 2`、`shareSeats: 2`、`shareCapacity: 8`，不能再生成 `weight: 4`。

```ts
expect(computePurchase(CATALOG, {
  line: "bind",
  items: [{ product: "anthropic", level: "max-20x" }],
  shareSeats: 2,
  deviceLimit: 1,
} as any).config).toMatchObject({
  line: "bind",
  products: ["anthropic"],
  levels: { anthropic: "max-20x" },
  shareSeats: 2,
  shareCapacity: 8,
  weight: 2,
  assignmentPolicy: "preferred-dynamic",
});
```

保留一个 legacy case：旧调用传 `shareUsers: 4` 时，为了 pending 旧订单兼容，应转换为 `shareSeats: 2`。

```ts
expect(computePurchase(CATALOG, {
  line: "bind",
  items: [{ product: "codex", level: "pro" }],
  shareUsers: 4,
  deviceLimit: 1,
} as any).config).toMatchObject({ shareSeats: 2, weight: 2 });
```

- [ ] **Step 2: 运行失败测试**

Run: `cd apps/server && pnpm vitest run src/leasing/plan-catalog/pricing.spec.ts`

Expected: FAIL，当前 `weight` 仍按 `shareCapacity / shareUsers` 计算。

Run: `cd apps/web && pnpm vitest run src/test/account/catalog-pricing.test.ts src/test/account/catalog-order-dialog.test.tsx`

Expected: FAIL，client mirror 仍使用旧 `shareUsers` 语义。

- [ ] **Step 3: 修改服务端纯 pricing**

在 `pricing.ts` 中把 `BindSelection` 扩展为新旧兼容：

```ts
export interface BindSelection {
  line: "bind";
  items: BindItem[];
  shareSeats?: number;
  /** Legacy: old UI sent passenger count; keep only for pending old clients. */
  shareUsers?: number;
  deviceLimit: number;
}

const SEAT_OPTIONS = [1, 2, 4, 8] as const;

function normalizeShareSeats(selection: BindSelection, shareCapacity: number): number {
  const explicit = Math.floor(Number(selection.shareSeats || 0));
  if (SEAT_OPTIONS.includes(explicit as any)) return explicit;
  const legacyUsers = Math.floor(Number(selection.shareUsers || 0));
  if (legacyUsers > 0) {
    const converted = Math.floor(shareCapacity / legacyUsers);
    if (SEAT_OPTIONS.includes(converted as any)) return converted;
  }
  throw new Error("shareSeats must be one of 1, 2, 4, 8");
}
```

在 `computeBind` 中改成：

```ts
const shareCapacity = catalog.shareCapacity ?? 8;
const shareSeats = normalizeShareSeats(selection, shareCapacity);
priceCents += bind.share[String(shareSeats)] ?? 0;

return {
  priceCents,
  config: {
    line: "bind",
    products,
    levels,
    shareSeats,
    shareCapacity,
    weight: shareSeats,
    assignmentPolicy: "preferred-dynamic",
    deviceLimit: selection.deviceLimit,
    windowMs: catalog.windowMs,
  },
};
```

- [ ] **Step 4: 同步 web mirror**

在 `apps/web/src/lib/account/catalog-pricing.ts` 做同样的类型和函数修改。`CatalogOrderFlow` 的测试 selection 改为 `shareSeats`：

```ts
const SELECTION: Selection = {
  line: "bind",
  items: [{ product: "codex", level: "pro" }],
  shareSeats: 1,
  deviceLimit: 1,
};
```

- [ ] **Step 5: 运行并提交**

Run: `cd apps/server && pnpm vitest run src/leasing/plan-catalog/pricing.spec.ts`

Expected: PASS。

Run: `cd apps/web && pnpm vitest run src/test/account/catalog-pricing.test.ts src/test/account/catalog-order-dialog.test.tsx`

Expected: PASS。

Commit:

```bash
git add apps/server/src/leasing/plan-catalog/pricing.ts apps/server/src/leasing/plan-catalog/pricing.spec.ts apps/web/src/lib/account/catalog-pricing.ts apps/web/src/test/account/catalog-pricing.test.ts apps/web/src/test/account/catalog-order-dialog.test.tsx
git commit -m "feat: normalize bind plans to seat counts"
```

---

## Task 2: 新增统一供给策略和额度基准解析

**Files:**
- Create: `apps/server/src/leasing/plan-catalog/unified-entitlement.ts`
- Create: `apps/server/src/leasing/plan-catalog/unified-entitlement.spec.ts`
- Create: `apps/server/src/leasing/plan-catalog/quota-baseline.service.ts`
- Create: `apps/server/src/leasing/plan-catalog/quota-baseline.service.spec.ts`
- Modify: `apps/server/src/leasing/plan-catalog/plan-catalog.module.ts`
- Modify: `apps/server/src/leasing/plan-catalog/pricing.ts`
- Modify: `apps/web/src/lib/account/catalog-pricing.ts`
- Modify: `apps/web/src/lib/console/plan-catalog-form.ts`
- Modify: `apps/web/src/test/console/plan-catalog-form.test.ts`

- [ ] **Step 1: 写失败测试：Antigravity Ultra 固定值**

`unified-entitlement.spec.ts`：

```ts
import { describe, expect, it } from "vitest";
import { buildFixedEntitlements, defaultSupplyPolicies } from "./unified-entitlement";

describe("buildFixedEntitlements", () => {
  it("uses fixed Antigravity Ultra baselines and scales by seats/8", () => {
    const config = {
      supplyPolicies: defaultSupplyPolicies(),
      shareCapacity: 8,
    } as any;

    const got = buildFixedEntitlements(config, {
      products: ["antigravity"],
      levels: { antigravity: "ultra" },
      shareSeats: 2,
      shareCapacity: 8,
    });

    expect(got.bucketLimits).toEqual({
      "antigravity-gemini": 25_000_000,
      "antigravity-claude": 3_000_000,
    });
    expect(got.weeklyBucketLimits).toEqual({
      "antigravity-gemini": 100_000_000,
      "antigravity-claude": 10_000_000,
    });
  });
});
```

- [ ] **Step 2: 写失败测试：目录表单保留供给策略**

`plan-catalog-form.test.ts` 增加 round-trip：

```ts
expect(formToConfig(configToForm({
  ...DEFAULT_CONFIG,
  supplyPolicies: {
    anthropic: {
      defaultLevel: "max-20x",
      salesSeatsPerAccount: { "max-20x": 10 },
      buckets: {
        "anthropic-claude": { source: "learned", provider: "anthropic", planType: "max-20x", family: "claude" },
      },
    },
  },
} as any) as any).supplyPolicies.anthropic.salesSeatsPerAccount["max-20x"]).toBe(10);
```

- [ ] **Step 3: 运行失败测试**

Run: `cd apps/server && pnpm vitest run src/leasing/plan-catalog/unified-entitlement.spec.ts src/leasing/plan-catalog/quota-baseline.service.spec.ts`

Expected: FAIL，新文件不存在。

Run: `cd apps/web && pnpm vitest run src/test/console/plan-catalog-form.test.ts`

Expected: FAIL，表单转换会丢弃 `supplyPolicies`。

- [ ] **Step 4: 实现统一策略纯 helper**

创建 `unified-entitlement.ts`：

```ts
export type QuotaSource =
  | { source: "fixed"; window5h: number; weekly: number }
  | { source: "learned"; provider: string; planType: string; family: string };

export interface SupplyPolicy {
  defaultLevel: string;
  salesSeatsPerAccount: Record<string, number>;
  buckets: Record<string, QuotaSource>;
}

export interface EntitlementInput {
  products: string[];
  levels: Record<string, string>;
  shareSeats: number;
  shareCapacity: number;
}

export function defaultSupplyPolicies(): Record<string, SupplyPolicy> {
  return {
    anthropic: {
      defaultLevel: "max-20x",
      salesSeatsPerAccount: { "max-20x": 10 },
      buckets: {
        "anthropic-claude": { source: "learned", provider: "anthropic", planType: "max-20x", family: "claude" },
      },
    },
    codex: {
      defaultLevel: "pro",
      salesSeatsPerAccount: { pro: 10 },
      buckets: {
        "codex-gpt": { source: "learned", provider: "codex", planType: "pro", family: "gpt" },
      },
    },
    antigravity: {
      defaultLevel: "ultra",
      salesSeatsPerAccount: { ultra: 10 },
      buckets: {
        "antigravity-gemini": { source: "fixed", window5h: 100_000_000, weekly: 400_000_000 },
        "antigravity-claude": { source: "fixed", window5h: 12_000_000, weekly: 40_000_000 },
      },
    },
  };
}

export function buildFixedEntitlements(catalog: any, input: EntitlementInput) {
  const policies = { ...defaultSupplyPolicies(), ...(catalog.supplyPolicies || {}) };
  const ratio = input.shareSeats / input.shareCapacity;
  const bucketLimits: Record<string, number> = {};
  const weeklyBucketLimits: Record<string, number> = {};
  for (const product of input.products) {
    const policy = policies[product];
    if (!policy) continue;
    for (const [bucket, source] of Object.entries(policy.buckets)) {
      if (source.source !== "fixed") continue;
      bucketLimits[bucket] = Math.floor(source.window5h * ratio);
      weeklyBucketLimits[bucket] = Math.floor(source.weekly * ratio);
    }
  }
  return { bucketLimits, weeklyBucketLimits };
}
```

- [ ] **Step 5: 实现 learned baseline 服务**

创建 `quota-baseline.service.ts`：

```ts
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { buildFixedEntitlements, defaultSupplyPolicies, type EntitlementInput } from "./unified-entitlement";

@Injectable()
export class QuotaBaselineService {
  constructor(private readonly prisma: PrismaService) {}

  async buildEntitlements(catalog: any, input: EntitlementInput) {
    const fixed = buildFixedEntitlements(catalog, input);
    const policies = { ...defaultSupplyPolicies(), ...(catalog.supplyPolicies || {}) };
    const ratio = input.shareSeats / input.shareCapacity;
    for (const product of input.products) {
      const policy = policies[product];
      if (!policy) continue;
      for (const [bucket, source] of Object.entries(policy.buckets)) {
        if ((source as any).source !== "learned") continue;
        const row = await this.prisma.quotaProfile.findUnique({
          where: {
            provider_planType_family: {
              provider: (source as any).provider,
              planType: (source as any).planType,
              family: (source as any).family,
            },
          },
        });
        const window5h = Math.floor(Number(row?.window5h || 0) * ratio);
        const weekly = Math.floor(Number(row?.weekly || 0) * ratio);
        if (window5h > 0) fixed.bucketLimits[bucket] = window5h;
        if (weekly > 0) fixed.weeklyBucketLimits[bucket] = weekly;
      }
    }
    return fixed;
  }
}
```

`plan-catalog.module.ts` 导出 `QuotaBaselineService`。

- [ ] **Step 6: 表单转换透传 supplyPolicies**

在 web 的 `CatalogConfig` 类型里增加：

```ts
supplyPolicies?: Record<string, {
  defaultLevel: string;
  salesSeatsPerAccount: Record<string, number>;
  buckets: Record<string, unknown>;
}>;
```

`configToForm` 和 `formToConfig` 先以只读 JSON 透传 `supplyPolicies`，下一任务再做可视化字段。

- [ ] **Step 7: 运行并提交**

Run: `cd apps/server && pnpm vitest run src/leasing/plan-catalog/unified-entitlement.spec.ts src/leasing/plan-catalog/quota-baseline.service.spec.ts`

Expected: PASS。

Run: `cd apps/web && pnpm vitest run src/test/console/plan-catalog-form.test.ts`

Expected: PASS。

Commit:

```bash
git add apps/server/src/leasing/plan-catalog apps/web/src/lib/account/catalog-pricing.ts apps/web/src/lib/console/plan-catalog-form.ts apps/web/src/test/console/plan-catalog-form.test.ts
git commit -m "feat: add unified entitlement baselines"
```

---

## Task 3: 购买和后台授予时固化 bucketLimits / weeklyBucketLimits

**Files:**
- Modify: `apps/server/src/leasing/account/billing/billing.service.ts`
- Modify: `apps/server/src/leasing/account/billing/__tests__/billing.service.catalog.spec.ts`
- Modify: `apps/server/src/leasing/account/billing/__tests__/catalog-lifecycle-e2e.spec.ts`
- Modify: `apps/server/src/leasing/subscription/subscription.service.ts`
- Modify: `apps/server/src/leasing/subscription/subscription-config.ts`
- Modify: `apps/server/src/leasing/subscription/subscription-config.spec.ts`
- Modify: `apps/server/src/leasing/subscription/config-fingerprint.ts`
- Modify: `apps/server/src/leasing/subscription/config-fingerprint.spec.ts`

- [ ] **Step 1: 写失败测试：订单 config 已经有固定额度**

在 `billing.service.catalog.spec.ts` 中 mock `QuotaBaselineService.buildEntitlements`，断言 `createCatalogOrder` 写入 `PlanOrder.config` 时已经包含 5h/周桶：

```ts
expect(JSON.parse(created.config)).toMatchObject({
  line: "bind",
  shareSeats: 2,
  bucketLimits: { "anthropic-claude": 20_000_000 },
  weeklyBucketLimits: { "anthropic-claude": 100_000_000 },
});
```

- [ ] **Step 2: 写失败测试：subscription record 带 weeklyBucketLimits**

`subscription-config.spec.ts`：

```ts
const record = subscriptionToLimitRecord({
  id: "sub_1",
  status: "ACTIVE",
  expiresAt: null,
  config: {
    line: "bind",
    products: ["anthropic"],
    levels: { anthropic: "max-20x" },
    shareSeats: 2,
    shareCapacity: 8,
    weight: 2,
    bucketLimits: { "anthropic-claude": 20_000_000 },
    weeklyBucketLimits: { "anthropic-claude": 100_000_000 },
    displayBindings: { anthropic: 12 },
    assignmentPolicy: "preferred-dynamic",
    windowMs: 18_000_000,
  },
});
expect(record).toMatchObject({
  bucketLimits: { "anthropic-claude": 20_000_000 },
  weeklyBucketLimits: { "anthropic-claude": 100_000_000 },
  displayBindings: { anthropic: 12 },
  assignmentPolicy: "preferred-dynamic",
});
```

- [ ] **Step 3: 运行失败测试**

Run: `cd apps/server && pnpm vitest run src/leasing/account/billing/__tests__/billing.service.catalog.spec.ts src/leasing/subscription/subscription-config.spec.ts src/leasing/subscription/config-fingerprint.spec.ts`

Expected: FAIL，当前订单只保存 `weight`，没有 `weeklyBucketLimits`。

- [ ] **Step 4: BillingService 注入并 enrich config**

构造函数加入：

```ts
private readonly quotaBaselines: QuotaBaselineService,
```

新增方法：

```ts
private async enrichUnifiedBindConfig(catalog: CatalogConfig, config: Record<string, any>) {
  if (config.line !== "bind") return config;
  const entitlements = await this.quotaBaselines.buildEntitlements(catalog, {
    products: Array.isArray(config.products) ? config.products : [],
    levels: config.levels || {},
    shareSeats: Number(config.shareSeats || config.weight || 1),
    shareCapacity: Number(config.shareCapacity || 8),
  });
  return {
    ...config,
    ...entitlements,
    assignmentPolicy: "preferred-dynamic",
  };
}
```

`createCatalogOrder` 和 `createGrantOrder` 都在 `computePurchase` 后调用：

```ts
config = await this.enrichUnifiedBindConfig(published.config as CatalogConfig, config as Record<string, any>);
```

- [ ] **Step 5: SubscriptionService 写 legacy mirror 时保留新字段**

新建订阅时保持 `config` 原样，legacy 列只做兼容：

```ts
bucketLimits: config.bucketLimits ? JSON.stringify(config.bucketLimits) : null,
weight: Number.isFinite(config.shareSeats) ? Number(config.shareSeats) : Number(config.weight || 1),
weeklyTokenLimit: Number.isFinite(config.weeklyTokenLimit) ? Number(config.weeklyTokenLimit) : null,
```

不要把 `weeklyBucketLimits` 压成 `weeklyTokenLimit`，否则 Antigravity 两个 bucket 会丢精度。

- [ ] **Step 6: subscription-config 支持新字段**

`subscriptionToLimitRecord` 的 bind 分支改为：

```ts
if (config.line === "bind") {
  return {
    ...base,
    bindings: config.displayBindings || config.bindings,
    displayBindings: config.displayBindings || config.bindings || {},
    assignmentPolicy: config.assignmentPolicy || "pinned",
    levels: config.levels || {},
    shareSeats: config.shareSeats ?? config.weight,
    shareCapacity: config.shareCapacity ?? 8,
    weight: config.weight ?? config.shareSeats ?? 1,
    bucketLimits: config.bucketLimits || {},
    weeklyBucketLimits: config.weeklyBucketLimits || {},
    requiresBinding: true,
  };
}
```

- [ ] **Step 7: 指纹改为购买意图**

`config-fingerprint.ts` bind 分支改为：

```ts
const levels = canonicalObject(config?.levels);
const seats = Number(config?.shareSeats ?? config?.weight) || 0;
return `bind|${products}|dev=${deviceLimit}|levels=${levels}|seats=${seats}`;
```

明确排除 `bucketLimits`、`weeklyBucketLimits`、`displayBindings`，避免学习基准变化导致同套餐续费被误判成新订阅。

- [ ] **Step 8: 运行并提交**

Run: `cd apps/server && pnpm vitest run src/leasing/account/billing/__tests__/billing.service.catalog.spec.ts src/leasing/account/billing/__tests__/catalog-lifecycle-e2e.spec.ts src/leasing/subscription/subscription-config.spec.ts src/leasing/subscription/config-fingerprint.spec.ts`

Expected: PASS。

Run: `cd apps/server && pnpm lint`

Expected: PASS。

Commit:

```bash
git add apps/server/src/leasing/account/billing apps/server/src/leasing/subscription
git commit -m "feat: snapshot unified bind entitlements"
```

---

## Task 4: 销售席位容量按产品/等级可配置

**Files:**
- Modify: `apps/server/src/leasing/subscription/seat.ts`
- Modify: `apps/server/src/leasing/subscription/seat.spec.ts`
- Modify: `apps/server/src/leasing/account/billing/billing.service.ts`
- Modify: `apps/server/src/leasing/account/billing/__tests__/billing.service.catalog.spec.ts`
- Modify: `apps/server/src/leasing/subscription/entitlement-sync.service.ts`
- Modify: `apps/server/src/leasing/subscription/__tests__/entitlement-sync.service.spec.ts`
- Modify: `apps/server/src/leasing/rosetta/access-key.service.ts`
- Modify: `apps/server/src/leasing/rosetta/__tests__/seat-availability.spec.ts`

- [ ] **Step 1: 写失败测试：容量 10 可卖十个 1 席**

`seat.spec.ts`：

```ts
expect(remainingSalesSeats(10, new Map([[1, 9]]), 1)).toBe(1);
expect(canSellSeats(10, new Map([[1, 9]]), 1, 1)).toBe(true);
expect(canSellSeats(10, new Map([[1, 9]]), 1, 2)).toBe(false);
```

`billing.service.catalog.spec.ts` 添加：一个账号 `salesSeatsPerAccount.pro=10`，已有 ACTIVE 订阅占 8 席，新购买 2 席允许；新购买 4 席拒绝。

- [ ] **Step 2: 运行失败测试**

Run: `cd apps/server && pnpm vitest run src/leasing/subscription/seat.spec.ts src/leasing/account/billing/__tests__/billing.service.catalog.spec.ts src/leasing/rosetta/__tests__/seat-availability.spec.ts`

Expected: FAIL，当前容量固定读 `ACCOUNT_SHARE_CAPACITY`。

- [ ] **Step 3: subscription seat helper 增加销售容量**

`seat.ts` 增加：

```ts
export function seatWeight(config: SubConfig): number {
  return Math.max(1, Math.floor(Number((config as any).shareSeats ?? config.weight) || 1));
}

export function remainingSalesSeats(capacity: number, occupied: Map<number, number>, accountId: number): number {
  return Math.max(0, Math.floor(Number(capacity) || 0) - (occupied.get(accountId) || 0));
}

export function canSellSeats(capacity: number, occupied: Map<number, number>, accountId: number, seats: number): boolean {
  return remainingSalesSeats(capacity, occupied, accountId) >= seats;
}
```

`occupiedSharesByAccount` 内部使用 `seatWeight(c)`，注释改为“销售席位”，不是实际 `ACCOUNT_SHARE_CAPACITY`。

- [ ] **Step 4: BillingService 按策略预检**

读取 catalog policy：

```ts
private salesCapacityFor(catalog: CatalogConfig, product: string, level: string): number {
  const policies = (catalog as any).supplyPolicies || {};
  return Math.max(1, Math.floor(Number(policies[product]?.salesSeatsPerAccount?.[level] || 8)));
}
```

`assertBindSeatsAvailable` 改签名接收 `catalog`，并传给 rosetta：

```ts
const capacity = this.salesCapacityFor(catalog, product, level);
if (!this.rosetta.hasAvailableSeatFromShares(product, weight, level, occupied, capacity)) {
  throw new BadRequestException(`${product}(${level})暂无可用座位,请稍后重试或联系客服`);
}
```

- [ ] **Step 5: Rosetta seat API 支持容量参数**

`AccessKeyService.assignSeatForProductFromShares` 新增 `salesCapacity = ACCOUNT_SHARE_CAPACITY` 参数：

```ts
free: salesCapacity - (occupiedShares.get(id) || 0),
```

`hasAvailableSeatFromShares` 同步新增参数并透传。

`EntitlementSyncService.syncBind` 也要用同一策略容量。它没有 catalog 上下文时，从订阅 config 的 `salesSeatCapacity` 或 `supplyPoliciesSnapshot` 读取；如果缺失，回退 8。购买 enrich config 时写入：

```ts
salesSeatCapacity: { anthropic: 10, codex: 10, antigravity: 10 }
```

- [ ] **Step 6: 运行并提交**

Run: `cd apps/server && pnpm vitest run src/leasing/subscription/seat.spec.ts src/leasing/account/billing/__tests__/billing.service.catalog.spec.ts src/leasing/subscription/__tests__/entitlement-sync.service.spec.ts src/leasing/rosetta/__tests__/seat-availability.spec.ts`

Expected: PASS。

Run: `cd apps/server && pnpm lint`

Expected: PASS。

Commit:

```bash
git add apps/server/src/leasing/subscription apps/server/src/leasing/account/billing apps/server/src/leasing/rosetta
git commit -m "feat: configure sales seat capacity"
```

---

## Task 5: weeklyBucketLimits 精确周额度

**Files:**
- Modify: `apps/server/src/leasing/token-server/access-key-store.ts`
- Modify: `apps/server/src/leasing/token-server/__tests__/access-key-store.spec.ts`
- Modify: `apps/server/src/leasing/token-server/__tests__/access-key-weekly-bucket-reset.spec.ts`
- Modify: `apps/server/src/leasing/token-server/__tests__/access-key-weekly-derived.spec.ts`

- [ ] **Step 1: 写失败测试：weeklyBucketLimits 优先于 weeklyTokenLimit 和派生值**

`access-key-store.spec.ts`：

```ts
const record: AccessKeyRecord = {
  id: "sub_1",
  key: "sub_key",
  status: "active",
  products: ["antigravity"],
  bucketLimits: { "antigravity-gemini": 25_000_000 },
  weeklyBucketLimits: { "antigravity-gemini": 100_000_000 },
  weeklyTokenUsageEvents: [{ at: Date.now(), totalTokens: 100_000_000, modelKey: "gemini-3-pro", product: "antigravity" }],
};
const got = store.precheckRecord(record, { modelKey: "gemini-3-pro", product: "antigravity", enforceLimit: true });
expect(got.allowed).toBe(false);
```

- [ ] **Step 2: 运行失败测试**

Run: `cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/access-key-store.spec.ts src/leasing/token-server/__tests__/access-key-weekly-bucket-reset.spec.ts src/leasing/token-server/__tests__/access-key-weekly-derived.spec.ts`

Expected: FAIL，当前周限额不读 `weeklyBucketLimits`。

- [ ] **Step 3: AccessKeyRecord 增加字段**

```ts
/** Per-composite-bucket weekly token caps. Takes precedence over weeklyTokenLimit. */
weeklyBucketLimits?: Record<string, number>;
```

- [ ] **Step 4: validateRecord 周检查优先读 per-bucket**

在 weekly check 中改成：

```ts
const weeklyBucketLimits = record.weeklyBucketLimits && typeof record.weeklyBucketLimits === "object"
  ? record.weeklyBucketLimits as Record<string, number>
  : {};
const explicitBucketWeekly = Number(weeklyBucketLimits[bucket] || 0);
if (explicitBucketWeekly > 0) {
  weeklyCap = explicitBucketWeekly;
} else if (explicitWeekly > 0) {
  weeklyCap = this.billing.bucketLimit(explicitWeekly, bucket, record);
} else {
  // keep existing derived weekly logic for legacy anthropic/codex records
}
```

- [ ] **Step 5: publicStatus weeklyBuckets 同口径**

`weeklyCapFor(bucket)` 使用完全相同的优先级：`weeklyBucketLimits[bucket]` > `weeklyTokenLimit` > derived anthropic/codex。

- [ ] **Step 6: 运行并提交**

Run: `cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/access-key-store.spec.ts src/leasing/token-server/__tests__/access-key-weekly-bucket-reset.spec.ts src/leasing/token-server/__tests__/access-key-weekly-derived.spec.ts`

Expected: PASS。

Run: `cd apps/server && pnpm lint`

Expected: PASS。

Commit:

```bash
git add apps/server/src/leasing/token-server/access-key-store.ts apps/server/src/leasing/token-server/__tests__
git commit -m "feat: enforce weekly bucket limits"
```

---

## Task 6: preferred-dynamic 运行时动态换号

**Files:**
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts`
- Modify: `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts`
- Modify: `apps/server/src/leasing/lease-core/__tests__/repro-bound-ignore-cooldown.spec.ts`
- Modify: `apps/server/src/leasing/lease-core/subscription-scheduler.ts`
- Modify: `apps/server/src/leasing/lease-core/__tests__/subscription-scheduler.spec.ts`

- [ ] **Step 1: 写失败测试：首绑没额度时换同产品同等级账号**

`lease-service.spec.ts` 新增 case：

```ts
it("preferred-dynamic uses display binding first, then falls back to a same-level account", async () => {
  // record: assignmentPolicy preferred-dynamic, displayBindings.codex = 1, levels.codex = "pro"
  // accounts: #1 pro blocked/exhausted for gpt model, #2 pro healthy
  // expect response.accountId === 2 and response.bound === false
});
```

- [ ] **Step 2: 写失败测试：同等级都没量时跨等级**

```ts
it("preferred-dynamic can fall back across levels when same-level accounts are unavailable", async () => {
  // #1 pro display exhausted, #2 pro exhausted, #3 plus healthy
  // expect accountId === 3
});
```

- [ ] **Step 3: 写失败测试：按 min(5h, weekly) 排序**

```ts
it("sorts fallback candidates by the tighter remaining 5h/weekly fraction", async () => {
  // #2 has 5h .9 weekly .1, #3 has 5h .5 weekly .5
  // expect #3 because min=.5 beats min=.1
});
```

- [ ] **Step 4: 运行失败测试**

Run: `cd apps/server && pnpm vitest run src/leasing/lease-core/__tests__/lease-service.spec.ts -t "preferred-dynamic"`

Expected: FAIL，当前 `boundAccountId > 0` 时 `maxAttempts=1`，不会 fallback。

- [ ] **Step 5: 增加 runtime 账号选择上下文**

在 `leaseToken` 中区分：

```ts
const preferredDisplayAccountId = this.accessKeyStore.boundAccountIdFor(auth.record, this.provider.id);
const isPreferredDynamic = String((auth.record as any).assignmentPolicy || "") === "preferred-dynamic";
const hardPinnedAccountId = isPreferredDynamic ? 0 : preferredDisplayAccountId;
```

客户级 fair-share 不再作为 preferred-dynamic 的额度来源；preferred-dynamic 的客户权益由 `bucketLimits` / `weeklyBucketLimits` 固定拦截。保留 legacy pinned bound card 的 fair-share。

- [ ] **Step 6: 新增 preferred-dynamic candidate builder**

在 `lease-service.ts` 添加：

```ts
private preferredDynamicAccounts(record: any, modelKey: string, payload: any): TAccount[] {
  const product = this.provider.id;
  const displayId = this.accessKeyStore.boundAccountIdFor(record, product);
  const level = String(record?.levels?.[product] || "").trim();
  const all = this.availableAccounts({ ...payload, ignorePoolEnabled: true }, modelKey, 0);
  const score = (account: TAccount) => {
    const a = account as any;
    const sameDisplay = account.id === displayId ? 0 : 1;
    const sameLevel = level && String(a.planType || "") === level ? 0 : 1;
    const quota = this.accountRemainingScore(account, modelKey);
    return { sameDisplay, sameLevel, quota };
  };
  return all.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    return sa.sameDisplay - sb.sameDisplay ||
      sa.sameLevel - sb.sameLevel ||
      sb.quota - sa.quota ||
      a.id - b.id;
  });
}
```

`accountRemainingScore` 返回 `min(remaining5hFraction, remainingWeeklyFraction)`；如果周数据未知，只返回 5h；如果都未知，返回 `1`。

- [ ] **Step 7: lease loop 使用 runtime candidates**

preferred-dynamic 下：

```ts
const runtimeCandidates = isPreferredDynamic
  ? this.preferredDynamicAccounts(auth.record, modelKey, payload)
  : null;
const maxAttempts = runtimeCandidates ? Math.min(MAX_TOKEN_CANDIDATE_SCAN_CAP, runtimeCandidates.length) : existingMaxAttempts;
```

每次 attempt 从 `runtimeCandidates` 取下一个账号，刷新 token 失败或账号被标记不可用就继续下一个。

返回体：

```ts
bound: hardPinnedAccountId > 0,
displayBound: isPreferredDynamic || preferredDisplayAccountId > 0,
serviceAccount: {
  accountId: account.id,
  emailHint: maskEmail(account.email),
  planType: (account as any).planType || "",
},
```

- [ ] **Step 8: `poolEnabled` 退出运行时过滤**

`availableAccounts` 删除 `(account as any).poolEnabled !== false` 过滤。保留字段在后台列表里显示历史状态，但 lease 不再读取它。

- [ ] **Step 9: 运行并提交**

Run: `cd apps/server && pnpm vitest run src/leasing/lease-core/__tests__/lease-service.spec.ts src/leasing/lease-core/__tests__/repro-bound-ignore-cooldown.spec.ts src/leasing/lease-core/__tests__/subscription-scheduler.spec.ts`

Expected: PASS。

Run: `cd apps/server && pnpm lint`

Expected: PASS。

Commit:

```bash
git add apps/server/src/leasing/lease-core
git commit -m "feat: dynamically fail over bound seats"
```

---

## Task 7: 客户购买页和后台套餐配置改成统一绑定线

**Files:**
- Modify: `apps/web/src/components/account/catalog-purchase.tsx`
- Modify: `apps/web/src/test/account/catalog-purchase.test.tsx`
- Modify: `apps/web/src/lib/account/catalog-pricing.ts`
- Modify: `apps/web/src/lib/console/plan-catalog-form.ts`
- Modify: `apps/web/src/test/console/plan-catalog-form.test.ts`
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(product)/plan-catalog/page.tsx`
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(product)/plan-catalog/pricing-section.tsx`
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(product)/plan-catalog/usage-section.tsx`
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(customer)/customers/[id]/grant-subscription-dialog.tsx`
- Modify: `apps/web/src/test/account/catalog-purchase.test.tsx`

- [ ] **Step 1: 写失败测试：客户只看到统一绑定线**

`catalog-purchase.test.tsx`：

```ts
render(<CatalogPurchase catalog={CATALOG} />);
expect(screen.queryByRole("tab", { name: /号池线/ })).not.toBeInTheDocument();
expect(screen.getByText(/1\/8/)).toBeInTheDocument();
expect(screen.getByText(/2\/8/)).toBeInTheDocument();
expect(screen.getByText(/4\/8/)).toBeInTheDocument();
expect(screen.getByText(/8\/8/)).toBeInTheDocument();
```

提交时 body 应为：

```ts
expect(body.selection).toMatchObject({
  line: "bind",
  shareSeats: 2,
});
expect(body.selection.shareUsers).toBeUndefined();
```

- [ ] **Step 2: 写失败测试：后台供给策略可编辑**

`plan-catalog-form.test.ts` 增加：

```ts
const form = configToForm(DEFAULT_CONFIG as any);
form.supplyPolicies.anthropic.salesSeatsPerAccount["max-20x"] = "10";
const config = formToConfig(form) as any;
expect(config.supplyPolicies.anthropic.salesSeatsPerAccount["max-20x"]).toBe(10);
```

- [ ] **Step 3: 运行失败测试**

Run: `cd apps/web && pnpm vitest run src/test/account/catalog-purchase.test.tsx src/test/console/plan-catalog-form.test.ts`

Expected: FAIL，当前 UI 仍有双 tab，表单状态还没有供给策略字段。

- [ ] **Step 4: 客户购买页移除 line tab**

`CatalogPurchase` 删除 `line` state、`poolProducts`、`usageTier`、号池 panel。保留产品选择、等级选择、席位选择、设备选择。

席位 state：

```ts
const [shareSeats, setShareSeats] = useState<number>(1);

const selection: Selection = {
  line: "bind",
  items: Object.entries(bindLevels).map(([product, level]) => ({ product, level })),
  shareSeats,
  deviceLimit: bindDevices,
};
```

席位按钮文案：

```tsx
{[1, 2, 4, 8].map((n) => (
  <button type="button" aria-checked={shareSeats === n}>
    {n}/8 席
  </button>
))}
```

- [ ] **Step 5: 后台套餐配置增加供给策略入口**

`PlanCatalogForm` 增加：

```ts
export interface SupplyPolicyForm {
  defaultLevel: string;
  salesSeatsPerAccount: Record<string, string>;
  buckets: Record<string, unknown>;
}
```

在 `pricing-section.tsx` 或新建 `supply-section.tsx` 显示：

- 产品。
- 默认基准等级。
- 每账号可售席位。
- 额度来源：学习或固定。
- 固定 5h/周数值。

Antigravity 默认固定值写入 DEFAULT_CONFIG：

```ts
supplyPolicies: defaultSupplyPolicies()
```

- [ ] **Step 6: 后台授予只发统一绑定线 selection**

`grant-subscription-dialog.tsx` 删除号池选项，selection 统一为：

```ts
{
  line: "bind",
  items,
  shareSeats,
  deviceLimit,
}
```

- [ ] **Step 7: 运行并提交**

Run: `cd apps/web && pnpm vitest run src/test/account/catalog-purchase.test.tsx src/test/account/catalog-pricing.test.ts src/test/console/plan-catalog-form.test.ts`

Expected: PASS。

Run: `cd apps/web && pnpm lint`

Expected: PASS。

Commit:

```bash
git add apps/web/src/components/account apps/web/src/lib apps/web/src/app/\\(console\\)/console/\\(dashboard\\)/\\(product\\)/plan-catalog apps/web/src/app/\\(console\\)/console/\\(dashboard\\)/\\(customer\\)/customers/[id]/grant-subscription-dialog.tsx apps/web/src/test
git commit -m "feat: expose unified bind plan purchase"
```

---

## Task 8: 客户门户展示席位和稳定卡额度

**Files:**
- Modify: `apps/server/src/leasing/account/portal/portal.service.ts`
- Modify: `apps/server/src/leasing/account/portal/__tests__/portal.service.spec.ts`
- Modify: `apps/web/src/lib/account/user-types.ts`
- Modify: `apps/web/src/lib/account/subscription-status.ts`
- Modify: `apps/web/src/test/account/subscription-status.test.ts`
- Modify: `apps/web/src/components/account/subscriptions-panel.tsx`
- Modify: `apps/web/src/test/account/subscription-status.test.ts`

- [ ] **Step 1: 写失败测试：门户返回 seatsLabel 和 5h/周 buckets**

`portal.service.spec.ts`：

```ts
expect(subscription).toMatchObject({
  shareSeats: 2,
  shareCapacity: 8,
  seatsLabel: "2/8 席",
  quota: {
    buckets: [{ bucket: "anthropic-claude", limit: 20_000_000 }],
    weeklyBuckets: [{ bucket: "anthropic-claude", limit: 100_000_000 }],
  },
});
```

- [ ] **Step 2: 运行失败测试**

Run: `cd apps/server && pnpm vitest run src/leasing/account/portal/__tests__/portal.service.spec.ts`

Expected: FAIL，当前 overview 未返回席位标签和 weekly buckets。

- [ ] **Step 3: PortalService 解析 config**

对每个订阅：

```ts
const config = parseConfig(s.config);
const shareSeats = Number(config.shareSeats ?? config.weight ?? s.weight ?? 1);
const shareCapacity = Number(config.shareCapacity ?? 8);
const seatsLabel = `${legacySeatLabel(config, shareSeats)}/${shareCapacity} 席`;
```

quota 使用 `bucketLimits` / `weeklyBucketLimits` 和运行时 store `publicStatus(record)` 的 used 值合并。

- [ ] **Step 4: Web 订阅面板展示血条，不显示 token 数**

`OverviewSubscription` 增加：

```ts
shareSeats?: number;
shareCapacity?: number;
seatsLabel?: string;
quota?: {
  buckets: Array<{ bucket: string; used: number; limit: number; resetMs?: number }>;
  weeklyBuckets?: Array<{ bucket: string; used: number; limit: number; resetMs?: number }>;
};
```

`subscriptionPlanLabel` 优先返回：

```ts
`${products.join("+")} · ${sub.seatsLabel}`
```

`SubscriptionsPanel` 的 meter 改成从 quota buckets 计算百分比，不展示 `formatTokens` 明细。

- [ ] **Step 5: 运行并提交**

Run: `cd apps/server && pnpm vitest run src/leasing/account/portal/__tests__/portal.service.spec.ts`

Expected: PASS。

Run: `cd apps/web && pnpm vitest run src/test/account/subscription-status.test.ts`

Expected: PASS。

Commit:

```bash
git add apps/server/src/leasing/account/portal apps/web/src/lib/account apps/web/src/components/account/subscriptions-panel.tsx apps/web/src/test/account
git commit -m "feat: show stable seat quota in portal"
```

---

## Task 9: 桌面客户端统一状态同步和额度展示

**Files:**
- Modify: `apps/app/leaser_status.go`
- Modify: `apps/app/leaser_test.go`
- Modify: `apps/app/codex_leaser.go`
- Modify: `apps/app/codex_leaser_test.go`
- Modify: `apps/app/claude_leaser.go`
- Modify: `apps/app/claude_leaser_test.go`
- Modify: `apps/app/bound_accounts.go`
- Modify: `apps/app/frontend/src/lib/quotaDisplay.ts`
- Modify: `apps/app/frontend/src/lib/quotaDisplay.test.ts`
- Modify: `apps/app/frontend/src/pages/DashboardPage.tsx`
- Modify: `apps/app/frontend/src/components/BoundAccountsCard.tsx`
- Modify: `apps/app/frontend/src/stores/useAppStore.ts`

- [ ] **Step 1: 写失败测试：Codex/Claude lease 回填 accessKeyStatus**

Go 测试：

```go
func TestCodexLeaseSyncsAccessKeyStatus(t *testing.T) {
  // fake lease response contains accessKeyStatus.quotaMode=static and products=["codex"]
  // after Acquire, GetLeaser().GetStatus()["accessKeyStatus"] must contain that status
}
```

Claude 同样覆盖 `products=["anthropic"]`。

- [ ] **Step 2: 写失败测试：quotaDisplay 输出两组血条**

`quotaDisplay.test.ts`：

```ts
expect(buildQuotaSections({
  bucket: "anthropic-claude",
  seatLabel: "Claude · 2/8 席",
  cardBuckets: { "anthropic-claude": { used: 5, limit: 20, resetMs: 1000 } },
  cardWeeklyBuckets: { "anthropic-claude": { used: 10, limit: 100, resetMs: 7000 } },
  accountFractions: { "anthropic-claude": 0.5 },
  accountResetMs: { "anthropic-claude": 2000 },
})).toMatchObject({
  title: "Claude · 2/8 席",
  mine: [{ window: "5h" }, { window: "7d" }],
  serviceAccount: [{ window: "5h" }],
});
```

- [ ] **Step 3: 运行失败测试**

Run: `cd apps/app && go test ./...`

Expected: FAIL，Codex/Claude 独立 leaser 没有调用 `syncQuotaStateFromBody`。

Run: `cd apps/app/frontend && pnpm vitest run src/lib/quotaDisplay.test.ts`

Expected: FAIL，当前 helper 只处理独享映射，不输出完整 section。

- [ ] **Step 4: Go 独立 leaser 同步主状态**

在 `codex_leaser.go` 成功解析 lease response 后增加：

```go
syncQuotaStateFromBody(GetLeaser(), body)
```

在 `claude_leaser.go` 同样增加。保留已有 `recordAccountBuckets` 和 `recordFairShareQuota` 没问题；如果重复写入相同值，结果幂等。

- [ ] **Step 5: Go status 暴露 seat fields**

`GetStatus` 中 `accessKeyStatus` 已透传；确保 `shareSeats`、`shareCapacity`、`quotaMode`、`products` 都保留。新增 helper：

```go
func cardSeatLabel(aks map[string]interface{}) string {
  seats := intFromAKS(aks, "shareSeats", intFromAKS(aks, "weight", 1))
  cap := intFromAKS(aks, "shareCapacity", 8)
  return fmt.Sprintf("%d/%d 席", seats, cap)
}
```

- [ ] **Step 6: 前端 quotaDisplay 生成“我的席位”和“当前服务账号”**

新增：

```ts
export type QuotaSection = {
  title: string;
  mine: DisplayBar[];
  serviceAccount: DisplayBar[];
};

export function buildQuotaSections(input: BuildQuotaInput): QuotaSection[] {
  // mine only from cardBuckets/cardWeeklyBuckets or myFractions
  // serviceAccount only from accountFractions/codexQuota/claudeQuota/latest lease account data
}
```

规则：

- “我的席位”：使用 `cardBuckets` / `cardWeeklyBuckets`；没有 static bucket 时用 `myFractions`。
- “当前服务账号”：使用 `codexQuota` / `claudeQuota` 优先，否则 `accountFractions`。
- 主血条 `used` / `limit` 对 static 可传入 `UsageBar`，但 label 不显示 token 数；如果 `UsageBar` 组件默认显示 token 数，增加 `hideValues` prop。

- [ ] **Step 7: DashboardPage 使用 section mapper**

替换当前 `modelRows` 内的混合逻辑：

```tsx
const sections = buildQuotaSections({ ...storeFields });
```

标题显示：

```text
Claude · 2/8 席
我的席位
当前服务账号
```

- [ ] **Step 8: BoundAccountsCard 改名**

文案 key 从 `bound.title` 改为“当前服务账号”。组件注释改为：

```ts
/**
 * 最新 lease 实际服务账号。preferred-dynamic 可能换号，所以这里不承诺固定绑定账号。
 */
```

如果多个产品都租过号，每个产品显示最近一次 lease 的账号；未租到的产品显示获取中。

- [ ] **Step 9: 运行并提交**

Run: `cd apps/app && go test ./...`

Expected: PASS。

Run: `cd apps/app/frontend && pnpm vitest run src/lib/quotaDisplay.test.ts`

Expected: PASS。

Run: `cd apps/app/frontend && pnpm lint`

Expected: PASS。

Commit:

```bash
git add apps/app apps/app/frontend
git commit -m "feat: display stable seat quota in desktop app"
```

---

## Task 10: 老卡和历史订阅迁移展示

**Files:**
- Modify: `apps/server/src/leasing/account/card-migration/card-migration.service.ts`
- Modify: `apps/server/src/leasing/account/card-migration/__tests__/card-migration.service.spec.ts`
- Modify: `apps/server/src/leasing/subscription/subscription-config.ts`
- Modify: `apps/server/src/leasing/subscription/subscription-config.spec.ts`
- Modify: `apps/server/src/leasing/account/portal/portal.service.ts`
- Modify: `apps/server/src/leasing/account/portal/__tests__/portal.service.spec.ts`

- [ ] **Step 1: 写失败测试：老静态卡保留额度，只换算展示席位**

```ts
expect(legacySeatFromBucketLimits({ "anthropic-claude": 8_000_000 })).toBe(1);
expect(legacySeatFromBucketLimits({ "anthropic-claude": 16_000_000 })).toBe(2);
expect(legacySeatFromBucketLimits({ "anthropic-claude": 32_000_000 })).toBe(4);
expect(legacySeatFromBucketLimits({ "anthropic-claude": 33_000_000 })).toBe(8);
```

- [ ] **Step 2: 运行失败测试**

Run: `cd apps/server && pnpm vitest run src/leasing/account/card-migration/__tests__/card-migration.service.spec.ts src/leasing/account/portal/__tests__/portal.service.spec.ts`

Expected: FAIL，当前没有 legacy 席位换算 helper。

- [ ] **Step 3: 新增老卡席位 helper**

在 `subscription-config.ts`：

```ts
export function legacySeatFromBucketLimits(bucketLimits: Record<string, number>): number {
  const values = Object.values(bucketLimits || {})
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 1);
  const max = values.length ? Math.max(...values) : 0;
  if (max <= 8_000_000) return 1;
  if (max <= 16_000_000) return 2;
  if (max <= 32_000_000) return 4;
  return 8;
}
```

- [ ] **Step 4: 迁移时不重算真实权益**

`card-migration.service.ts` 对老静态卡：

```ts
config.bucketLimits = old.bucketLimits;
config.weeklyTokenLimit = old.weeklyTokenLimit;
config.shareSeats = legacySeatFromBucketLimits(old.bucketLimits || {});
config.shareCapacity = 8;
config.assignmentPolicy = "preferred-dynamic";
config.legacyDisplay = true;
```

只有能无损映射时才写 `weeklyBucketLimits`；否则保留 `weeklyTokenLimit`。

- [ ] **Step 5: 老绑定卡保留首绑账号**

迁移绑定卡：

```ts
config.displayBindings = old.bindings || oldLegacyBinding;
config.bindings = config.displayBindings;
config.assignmentPolicy = "preferred-dynamic";
```

不要改 `bucketLimits`、用量窗口或旧订单有效期。

- [ ] **Step 6: 运行并提交**

Run: `cd apps/server && pnpm vitest run src/leasing/account/card-migration/__tests__/card-migration.service.spec.ts src/leasing/subscription/subscription-config.spec.ts src/leasing/account/portal/__tests__/portal.service.spec.ts`

Expected: PASS。

Run: `cd apps/server && pnpm lint`

Expected: PASS。

Commit:

```bash
git add apps/server/src/leasing/account/card-migration apps/server/src/leasing/subscription apps/server/src/leasing/account/portal
git commit -m "feat: migrate legacy cards to seat display"
```

---

## Task 11: 下线客户可见号池线和 poolEnabled 运行时语义

**Files:**
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts`
- Modify: `apps/server/src/leasing/rosetta/antigravity-account.service.ts`
- Modify: `apps/server/src/leasing/rosetta/claude-account.service.ts`
- Modify: `apps/server/src/leasing/rosetta/codex.service.ts`
- Modify: `apps/server/src/leasing/rosetta/__tests__/rosetta.service.spec.ts`
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(product)/plan-catalog/*`

- [ ] **Step 1: 写失败测试：poolEnabled=false 仍可作为供给账号**

在 `lease-service.spec.ts` 中构造账号：

```ts
{ id: 1, enabled: true, poolEnabled: false, refreshToken: "rt", planType: "pro" }
```

未指定 hard pinned 时也应该能被 preferred-dynamic fallback 选中。

- [ ] **Step 2: 运行失败测试**

Run: `cd apps/server && pnpm vitest run src/leasing/lease-core/__tests__/lease-service.spec.ts -t "poolEnabled"`

Expected: FAIL，当前 `availableAccounts` 会过滤 `poolEnabled=false`。

- [ ] **Step 3: 移除 lease 过滤**

删除：

```ts
(boundAccountId ? true : (account as any).poolEnabled !== false) &&
```

同步修改 `poolUnavailableMessage` 中的统计过滤，避免错误计算可用账号数量。

- [ ] **Step 4: 后台账号 UI 降级 poolEnabled**

保留历史字段展示可以叫“历史出池状态”，但不再提供“出池/入池”作为运行时开关。运营要移出供给只用 `enabled=false`。

三类 account service 的 toggle pool 接口标记为 legacy；前端隐藏按钮。

- [ ] **Step 5: 运行并提交**

Run: `cd apps/server && pnpm vitest run src/leasing/lease-core/__tests__/lease-service.spec.ts src/leasing/rosetta/__tests__/rosetta.service.spec.ts`

Expected: PASS。

Run: `cd apps/server && pnpm lint`

Expected: PASS。

Commit:

```bash
git add apps/server/src/leasing/lease-core apps/server/src/leasing/rosetta apps/web/src/app/\\(console\\)/console/\\(dashboard\\)/\\(product\\)/plan-catalog
git commit -m "feat: retire pool enabled runtime filtering"
```

---

## Task 12: 端到端验证和发布闸门

**Files:**
- Modify: `apps/server/src/shared/__tests__/app-lease-e2e.spec.ts`
- Modify: `apps/server/src/leasing/account/billing/__tests__/billing-integration.spec.ts`
- Modify: `apps/web/src/test/account/catalog-purchase.test.tsx`
- Modify: `apps/app/leaser_test.go`

- [ ] **Step 1: 增加 E2E：购买 2 席 Claude，首绑耗尽后换号**

测试流程：

1. 发布 catalog，Claude `max-20x` 每账号可售 10 席。
2. 客户购买 `shareSeats=2`。
3. 订单 config 含 `bucketLimits` 和 `weeklyBucketLimits`。
4. 首绑账号 #1 被标记额度耗尽。
5. lease 返回 #2。
6. response `accessKeyStatus.quotaMode === "static"`。
7. response `bound === false` 且 `displayBound === true`。

- [ ] **Step 2: 增加 E2E：客户额度耗尽优先于账号 fallback**

同一订阅把 `bucketLimits["anthropic-claude"]` 用满后，请求直接 429，不继续换其它账号。

- [ ] **Step 3: 增加 E2E：Antigravity Ultra 固定周额度**

购买 `shareSeats=1` Antigravity Ultra 后断言：

```ts
bucketLimits["antigravity-gemini"] === 12_500_000
weeklyBucketLimits["antigravity-gemini"] === 50_000_000
bucketLimits["antigravity-claude"] === 1_500_000
weeklyBucketLimits["antigravity-claude"] === 5_000_000
```

- [ ] **Step 4: 全量验证**

Run: `cd apps/server && pnpm vitest run`

Expected: PASS。

Run: `cd apps/server && pnpm lint`

Expected: PASS。

Run: `cd apps/web && pnpm vitest run`

Expected: PASS。

Run: `cd apps/web && pnpm lint`

Expected: PASS。

Run: `cd apps/app && go test ./...`

Expected: PASS。

Run: `cd apps/app/frontend && pnpm vitest run`

Expected: PASS。

- [ ] **Step 5: 发布前人工检查**

检查一张新 2/8 Claude 卡：

- 购买页只看到产品/类型和 `1/2/4/8` 席。
- 桌面端标题显示 `Claude · 2/8 席`。
- “我的席位”有 5h 和周血条。
- 首绑账号没额度时请求仍可成功，并且“当前服务账号”切到新账号。
- 客户看不到超卖、fallback、后台账号剩余席位。

Commit:

```bash
git add apps/server/src/shared/__tests__ apps/server/src/leasing/account/billing/__tests__ apps/web/src/test/account apps/app
git commit -m "test: cover unified bind dynamic supply"
```

---

## Rollout Notes

- 先部署 server，确保旧客户端仍能读 `accessKeyStatus` 和 legacy `weeklyTokenLimit`。
- 再发布 web，隐藏号池购买入口，但保留服务端对旧 `line: "pool"` selection 的兼容。
- 最后发布 Wails 客户端，展示“我的席位”和“当前服务账号”。
- 老卡迁移分批执行，迁移前备份订阅表、`access-keys.json` 和三类 account json。
- 若运行时 fallback 出现异常，可临时把新订阅 `assignmentPolicy` 改回 `"pinned"`，旧 `bindings` 镜像仍可工作。

## Self-Review

- Spec coverage: 统一绑定线、席位制、超卖配置、购买不展示账号、固定 5h/周额度、Antigravity 固定 Ultra 基准、首绑优先 fallback、跨等级、按 5h/周较紧余额排序、客户端稳定血条、老卡展示换算都对应了上面的任务。
- Placeholder scan: 文档已完成占位符检查，没有遗留占位标记。
- Type consistency: 新语义统一使用 `shareSeats` 表示客户购买席位，`shareCapacity` 固定展示分母，`salesSeatsPerAccount` 表示后台每账号可售席位容量，`displayBindings` 表示首绑/展示账号，`assignmentPolicy` 控制运行时是否可换号。
