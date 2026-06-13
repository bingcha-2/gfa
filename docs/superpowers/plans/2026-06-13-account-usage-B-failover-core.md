# 子计划 B：接力核心 — leaseToken 账户化 + 订阅优先级自动接力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `leaseToken` 收到请求后,按 `priority` 在该账户的多个订阅间**自动接力** —— 当前订阅某产品额度用尽时,自动切到下一个还有额度的订阅;全部用尽才 429。

**Architecture:** 不改 session JWT。`resolveFromRequest` 照常拿到 record → 用 `record.customerId`(子计划 A 已让 record 带上)列出同账户的 ACTIVE 订阅 record,按 `priority` 升序,逐个跑**只读三道闸预检**(bucketLimits/weekly 经 `precheckRecord`,fair-share 经 `checkFairShare`,各订阅用各自的 `boundAccountId` —— **不限定同母号**),选第一个全过的替换 `auth.record`。新增独立类 `SubscriptionScheduler`(注入 store + fairShareTracker)。零新增定时任务(订阅过期复用现有 `SubscriptionExpiryService`)。

**Tech Stack:** NestJS + Prisma(SQLite) + Vitest;pnpm workspace(`@gfa/server`)。

> ⚠️ **守"server 验证盲区"memory**:`.spec.ts` 不进 CLI tsc、vitest 不查类型。**每个 Task 末跑 `cd apps/server && pnpm lint`(= `tsc --noEmit`,EXIT 0 才算过)**。提交后若见 IDE `new-diagnostics` 报错但 `pnpm lint` EXIT 0,那是**陈旧诊断**(子计划 A 全程如此),以 CLI tsc 为准。测试用 `prisma/test.db`(非 dev.db);本计划测试均 mock/内存,不连真实 DB,无需动 test.db。

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `apps/server/src/leasing/subscription/subscription-config.ts` | 订阅 config → 限额 record | `SubscriptionRow` + `subscriptionToLimitRecord` 加 `priority` |
| `apps/server/src/leasing/subscription/subscription-config.spec.ts` | 上者单测 | 加 `priority` 断言 |
| `apps/server/src/leasing/subscription/entitlement-sync.service.ts` | 订阅激活同步 | `registerRecord` 传 `priority` |
| `apps/server/src/leasing/token-server/token-server.service.ts` | boot 加载订阅 | select + map 传 `priority` |
| `apps/server/src/leasing/token-server/access-key-store.ts` | 内存卡/订阅 record | ① `AccessKeyRecord` 加 `priority?`;② 加 `listByCustomerSorted`;③ `validateRecord` 加 `dryRun`;④ 加 public `precheckRecord` |
| `apps/server/src/leasing/token-server/__tests__/access-key-store.spec.ts` | 上者单测 | listByCustomerSorted + precheckRecord case |
| `apps/server/src/leasing/lease-core/subscription-scheduler.ts` | **新建** | `SubscriptionScheduler` 接力选订阅 |
| `apps/server/src/leasing/lease-core/__tests__/subscription-scheduler.spec.ts` | **新建** | scheduler 单测 |
| `apps/server/src/leasing/lease-core/lease-service.ts` | leaseToken 入口 | 插入接力 + 注入 scheduler + 返回体加 `activeSubscriptionId` |
| `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts` | 集成测 | 多订阅接力 case |

---

## Task B1: `priority` 进 record(单元 TDD)

**Files:**
- Modify: `apps/server/src/leasing/subscription/subscription-config.ts`(SubscriptionRow ~76-82, subscriptionToLimitRecord ~88-101)
- Modify: `apps/server/src/leasing/subscription/subscription-config.spec.ts`
- Modify: `apps/server/src/leasing/token-server/access-key-store.ts`(AccessKeyRecord ~61-120)

- [ ] **Step 1: 写失败测试** —— 在 `subscription-config.spec.ts` 的两个 `subscriptionToLimitRecord` case 里,入参加 `priority`、`toEqual` 期望加 `priority`。第一个(号池):入参加 `priority: 3`,期望对象加 `priority: 3`。第二个(绑定):入参加 `priority: 0`,期望加 `priority: 0`。

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/server && pnpm vitest run src/leasing/subscription/subscription-config.spec.ts -t "subscriptionToLimitRecord"`
Expected: FAIL —— record 不含 `priority`。

- [ ] **Step 3: 实现**

`subscription-config.ts` 的 `SubscriptionRow` 加 `priority?: number`:
```typescript
export interface SubscriptionRow {
  id: string;
  customerId?: string;
  priority?: number;
  status: string;
  expiresAt: Date | null;
  config: Record<string, any>;
}
```
`subscriptionToLimitRecord` 的 `base` 加 `priority`(在 `customerId` 后):
```typescript
  const base: Record<string, unknown> = {
    id: sub.id,
    customerId: sub.customerId,
    priority: sub.priority ?? 0,
    status: sub.status === "ACTIVE" ? "active" : "expired",
    products: config.products,
    windowMs: config.windowMs,
    keyExpiresAt: sub.expiresAt ? sub.expiresAt.toISOString() : undefined,
  };
```
`access-key-store.ts` 的 `AccessKeyRecord` 接口(在 `customerId?: string;` 下方)加:
```typescript
  /** Account-internal failover order (mirrors Subscription.priority); lower = used
   *  first. Set on subscription shadow records; legacy cards leave it undefined. */
  priority?: number;
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd apps/server && pnpm vitest run src/leasing/subscription/subscription-config.spec.ts -t "subscriptionToLimitRecord"`
Expected: PASS。

- [ ] **Step 5: 验类型 + Commit**

```bash
cd apps/server && pnpm lint
git add apps/server/src/leasing/subscription/subscription-config.ts apps/server/src/leasing/subscription/subscription-config.spec.ts apps/server/src/leasing/token-server/access-key-store.ts
git commit -m "feat(server): subscriptionToLimitRecord 输出 priority、AccessKeyRecord 加 priority 字段"
```

---

## Task B2: 注册路径传 `priority`(单元 TDD)

**Files:**
- Modify: `apps/server/src/leasing/subscription/entitlement-sync.service.ts`(registerRecord ~117-125)
- Modify: `apps/server/src/leasing/token-server/token-server.service.ts`(boot 加载 ~151-160)
- Test: `apps/server/src/leasing/token-server/__tests__/access-key-store.spec.ts`

- [ ] **Step 1: 写测试(透传)** —— 在 `access-key-store.spec.ts` 的"customerId 透传"describe 里(子计划 A 加的)补一条,或新加一个 it,验证 priority 透传:
```typescript
  it("loadSubscriptionRecords 注册带 priority 的 record → findById 可取回", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-prio-"));
    const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
    store.loadSubscriptionRecords([
      { id: "sub-p", customerId: "cust-1", priority: 7, status: "active", products: ["codex"] },
    ]);
    expect(store.findById("sub-p")?.priority).toBe(7);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
```

- [ ] **Step 2: 跑测试,确认通过(store spread 已透传)**

Run: `cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/access-key-store.spec.ts -t "priority"`
Expected: PASS(`loadSubscriptionRecords` 的 `{...rec}` 已带 priority)。**若 FAIL**,检查 `loadSubscriptionRecords` 是否剔除了该字段。

- [ ] **Step 3: 改两个注册调用点传 priority**

`entitlement-sync.service.ts` 的 `registerRecord`(给 `subscriptionToLimitRecord` 入参加 `priority: sub.priority`):
```typescript
    const record = subscriptionToLimitRecord({
      id: sub.id,
      customerId: sub.customerId,
      priority: sub.priority,
      status: sub.status,
      expiresAt: sub.expiresAt,
      config,
    });
```
`token-server.service.ts` 的 boot 加载:`findMany` 的 `select` 加 `priority: true`,`map` 里 `subscriptionToLimitRecord` 入参加 `priority: s.priority`:
```typescript
        select: {
          id: true, customerId: true, priority: true, status: true, expiresAt: true, productEntitlements: true,
          bucketLimits: true, bindings: true, levels: true, weight: true,
          deviceLimit: true, weeklyTokenLimit: true, windowMs: true,
        },
```
```typescript
        subscriptionToLimitRecord({ id: s.id, customerId: s.customerId, priority: s.priority, status: s.status, expiresAt: s.expiresAt, config: legacyColumnsToConfig(s) }),
```

- [ ] **Step 4: 跑测试 + 验类型**

Run: `cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/access-key-store.spec.ts src/leasing/subscription && pnpm lint`
Expected: PASS;tsc EXIT 0(`sub.priority`/`s.priority` 类型存在)。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/leasing/subscription/entitlement-sync.service.ts apps/server/src/leasing/token-server/token-server.service.ts apps/server/src/leasing/token-server/__tests__/access-key-store.spec.ts
git commit -m "feat(server): 订阅同步把 priority 带进内存 record"
```

---

## Task B3: `AccessKeyStore.listByCustomerSorted`(单元 TDD)

**Files:**
- Modify: `apps/server/src/leasing/token-server/access-key-store.ts`(在 `listSubscriptionRecords` ~277 后加方法)
- Test: `apps/server/src/leasing/token-server/__tests__/access-key-store.spec.ts`

- [ ] **Step 1: 写失败测试**
```typescript
describe("listByCustomerSorted — 账户订阅按 priority 升序", () => {
  it("只返回该 customer 的 ACTIVE 订阅,按 priority 升序", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-list-"));
    const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
    store.loadSubscriptionRecords([
      { id: "s-b", customerId: "c1", priority: 5, status: "active", products: ["codex"] },
      { id: "s-a", customerId: "c1", priority: 1, status: "active", products: ["codex"] },
      { id: "s-exp", customerId: "c1", priority: 0, status: "expired", products: ["codex"] },
      { id: "s-other", customerId: "c2", priority: 0, status: "active", products: ["codex"] },
    ]);
    const ids = store.listByCustomerSorted("c1").map((r) => r.id);
    expect(ids).toEqual(["s-a", "s-b"]); // 升序、排除 expired、排除 c2
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/access-key-store.spec.ts -t "listByCustomerSorted"`
Expected: FAIL —— `store.listByCustomerSorted is not a function`。

- [ ] **Step 3: 实现** —— 在 `listSubscriptionRecords()` 方法后加:
```typescript
  /**
   * 列出某 customerId 的所有 ACTIVE 订阅 record,按 priority 升序(小=优先)。
   * 供 SubscriptionScheduler 做账户级接力。只看内存 subscriptionById(订阅卡),
   * 文件卡不参与账户接力(无 customerId)。
   */
  listByCustomerSorted(customerId: string): AccessKeyRecord[] {
    if (!customerId) return [];
    const out: AccessKeyRecord[] = [];
    for (const rec of this.subscriptionById.values()) {
      if (rec.customerId === customerId && String(rec.status || "active") === "active") {
        out.push(rec);
      }
    }
    return out.sort((a, b) => (Number(a.priority ?? 0)) - (Number(b.priority ?? 0)));
  }
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/access-key-store.spec.ts -t "listByCustomerSorted"`
Expected: PASS。

- [ ] **Step 5: 验类型 + Commit**

```bash
cd apps/server && pnpm lint
git add apps/server/src/leasing/token-server/access-key-store.ts apps/server/src/leasing/token-server/__tests__/access-key-store.spec.ts
git commit -m "feat(server): AccessKeyStore.listByCustomerSorted — 账户订阅按 priority 升序"
```

---

## Task B4: `validateRecord` 加 `dryRun` + public `precheckRecord`(单元 TDD)

**Files:**
- Modify: `apps/server/src/leasing/token-server/access-key-store.ts`(validateRecord ~530-634 加 dryRun 守卫;新增 public precheckRecord)
- Test: `apps/server/src/leasing/token-server/__tests__/access-key-store.spec.ts`

> 背景:`validateRecord` 有 4 处 `this.writeCache()`(行 547/577/621/632)+ 行 546 `record.status='expired'` 是副作用。`dryRun` 只跳过这些持久化/状态写,保留窗口翻转(内存维护、算用量必需)。`precheckRecord` 封装它供 scheduler 调。

- [ ] **Step 1: 写失败测试**
```typescript
describe("precheckRecord — 只读三道闸预检", () => {
  it("bucket 已超额 → allowed=false + resetMs;且不写缓存(record.status 不变)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-pre-"));
    const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
    // 一张已把 codex-gpt 桶用满的订阅 record(限额 100,已用 100)
    store.loadSubscriptionRecords([{
      id: "s1", customerId: "c1", status: "active", products: ["codex"],
      bucketLimits: { "codex-gpt": 100 }, windowMs: 18_000_000,
      tokenUsageEvents: [{ at: new Date().toISOString(), status: 200, bucket: "codex-gpt", totalTokens: 100 }],
    }]);
    const rec = store.findById("s1")!;
    const res = store.precheckRecord(rec, { modelKey: "gpt-5-codex", product: "codex", enforceLimit: true });
    expect(res.allowed).toBe(false);
    expect(res.resetMs).toBeGreaterThan(0);
    expect(rec.status).toBe("active"); // 预检未把它改成 expired/写缓存
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("额度充足 → allowed=true", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-pre2-"));
    const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
    store.loadSubscriptionRecords([{
      id: "s2", customerId: "c1", status: "active", products: ["codex"],
      bucketLimits: { "codex-gpt": 100000 }, windowMs: 18_000_000,
    }]);
    const res = store.precheckRecord(store.findById("s2")!, { modelKey: "gpt-5-codex", product: "codex", enforceLimit: true });
    expect(res.allowed).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/access-key-store.spec.ts -t "precheckRecord"`
Expected: FAIL —— `store.precheckRecord is not a function`。

- [ ] **Step 3a: validateRecord 加 dryRun 守卫** —— `options` 类型加 `dryRun?: boolean`,并把 4 处 `this.writeCache()` 与行 546 的 status 赋值用 `if (!options.dryRun)` 守卫:

行 534 options 类型补 `dryRun?: boolean`:
```typescript
    options: { activate?: boolean; enforceLimit?: boolean; dryRun?: boolean; modelKey?: string; product?: string; alignedResetAt?: number | ((record: any) => number); weeklyRatio?: number | ((record: any) => number) } = {},
```
行 545-548(过期):
```typescript
    if (expiresAt && Date.parse(expiresAt) <= now) {
      if (!options.dryRun) { record.status = 'expired'; this.writeCache(); }
      return { key: keyValue, record: null, error: 'Access key expired' };
    }
```
行 576-577(bucket 超额):
```typescript
        if (limit > 0 && used >= limit) {
          if (!options.dryRun) this.writeCache();
```
行 620-621(weekly 超额):
```typescript
          if (used >= weeklyCap) {
            if (!options.dryRun) this.writeCache();
```
行 632(activate 收尾):
```typescript
    if (options.activate && !options.dryRun) this.writeCache();
```

- [ ] **Step 3b: 加 public precheckRecord** —— 在 `validateRecord` 方法后加:
```typescript
  /**
   * 只读三道闸预检(bucketLimits + weekly + expiry/status),供 SubscriptionScheduler
   * 对候选订阅逐个判断"当前 bucket 还有没有额度"。复用 validateRecord 的 dryRun 模式,
   * 绝不写缓存、不改 record 状态。fair-share(第三道闸)由 scheduler 另调 checkFairShare。
   */
  precheckRecord(
    record: AccessKeyRecord,
    options: { modelKey?: string; product?: string; alignedResetAt?: number | ((record: any) => number); weeklyRatio?: number | ((record: any) => number); enforceLimit?: boolean },
  ): { allowed: boolean; resetMs?: number; reason?: string } {
    const res = this.validateRecord(String(record.key || record.id), record, this.readAll(), {
      ...options,
      enforceLimit: options.enforceLimit ?? true,
      dryRun: true,
    });
    if (res.record) return { allowed: true };
    return { allowed: false, resetMs: res.resetMs, reason: res.error };
  }
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/access-key-store.spec.ts -t "precheckRecord"`
Expected: PASS(两个 case 都过,且 `rec.status` 保持 "active")。

- [ ] **Step 5: 跑全 token-server 测试(防回归)+ 验类型**

Run: `cd apps/server && pnpm vitest run src/leasing/token-server && pnpm lint`
Expected: 全 PASS(dryRun 守卫不影响非 dryRun 的既有调用);tsc EXIT 0。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/leasing/token-server/access-key-store.ts apps/server/src/leasing/token-server/__tests__/access-key-store.spec.ts
git commit -m "feat(server): validateRecord 加 dryRun + precheckRecord 只读三道闸预检"
```

---

## Task B5: `SubscriptionScheduler` 类(单元 TDD)

**Files:**
- Create: `apps/server/src/leasing/lease-core/subscription-scheduler.ts`
- Create: `apps/server/src/leasing/lease-core/__tests__/subscription-scheduler.spec.ts`

- [ ] **Step 1: 写失败测试(新文件)** —— 用轻量 fake store/tracker 驱动接力逻辑:
```typescript
import { describe, expect, it, vi } from "vitest";
import { SubscriptionScheduler } from "../subscription-scheduler";

function makeStore(records: any[], precheck: (rec: any) => { allowed: boolean; resetMs?: number }) {
  return {
    listByCustomerSorted: (cid: string) => records.filter((r) => r.customerId === cid),
    precheckRecord: (rec: any) => precheck(rec),
    boundAccountIdFor: (rec: any) => Number(rec.boundAccountId || 0),
  } as any;
}

describe("SubscriptionScheduler — 优先级接力", () => {
  const opts = { customerId: "c1", providerId: "codex", modelKey: "gpt-5-codex", bucket: "codex-gpt", precheckOptions: {} as any };

  it("优先级最高的订阅有额度 → 直接选它", () => {
    const store = makeStore(
      [{ id: "s1", customerId: "c1", boundAccountId: 10 }, { id: "s2", customerId: "c1", boundAccountId: 10 }],
      () => ({ allowed: true }),
    );
    const sched = new SubscriptionScheduler(store, null);
    expect(sched.selectForFailover(opts)?.id).toBe("s1");
  });

  it("s1 桶满 → 接力到 s2", () => {
    const store = makeStore(
      [{ id: "s1", customerId: "c1", boundAccountId: 10 }, { id: "s2", customerId: "c1", boundAccountId: 10 }],
      (rec) => ({ allowed: rec.id !== "s1", resetMs: 5000 }),
    );
    const sched = new SubscriptionScheduler(store, null);
    expect(sched.selectForFailover(opts)?.id).toBe("s2");
  });

  it("全部桶满 → null", () => {
    const store = makeStore(
      [{ id: "s1", customerId: "c1", boundAccountId: 10 }, { id: "s2", customerId: "c1", boundAccountId: 10 }],
      () => ({ allowed: false, resetMs: 5000 }),
    );
    expect(new SubscriptionScheduler(store, null).selectForFailover(opts)).toBeNull();
  });

  it("fair-share 拦截 s1 → 接力到 s2(各订阅用各自 boundAccountId)", () => {
    const store = makeStore(
      [{ id: "s1", customerId: "c1", boundAccountId: 10 }, { id: "s2", customerId: "c1", boundAccountId: 20 }],
      () => ({ allowed: true }),
    );
    const tracker = { checkFairShare: (acc: number, card: string) => ({ allowed: card !== "s1" }) } as any;
    const sched = new SubscriptionScheduler(store, tracker);
    const picked = sched.selectForFailover(opts);
    expect(picked?.id).toBe("s2");
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/server && pnpm vitest run src/leasing/lease-core/__tests__/subscription-scheduler.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现(新文件 `subscription-scheduler.ts`)**
```typescript
/**
 * subscription-scheduler.ts — 账户级订阅优先级接力。
 *
 * leaseToken 拿到当前订阅 record 后,用 record.customerId 列出该账户的所有 ACTIVE
 * 订阅(按 priority 升序),逐个跑只读三道闸预检,选第一个"当前 bucket 还有额度"的。
 * 每个候选订阅用各自的 boundAccountId 做 fair-share 预检 —— 不限定同一上游母号,
 * 所以订阅A(绑母号X)claude 用完能切到订阅B(绑母号Y)。全部用尽返回 null。
 *
 * 无副作用:预检全只读(precheckRecord 用 dryRun、checkFairShare 本就只读)。
 */
import type { AccessKeyRecord, AccessKeyStore } from "../token-server/access-key-store";

type FairShareLike = { checkFairShare(accountId: number, cardId: string, bucket: string): { allowed: boolean } };

type PrecheckOptions = {
  modelKey?: string;
  product?: string;
  alignedResetAt?: number | ((record: any) => number);
  weeklyRatio?: number | ((record: any) => number);
};

export interface FailoverQuery {
  customerId: string;
  providerId: string;
  modelKey: string;
  bucket: string;
  precheckOptions: PrecheckOptions;
}

export class SubscriptionScheduler {
  constructor(
    private readonly store: Pick<AccessKeyStore, "listByCustomerSorted" | "precheckRecord" | "boundAccountIdFor">,
    private readonly fairShareTracker: FairShareLike | null,
  ) {}

  /**
   * 按 priority 选第一个"三道闸全过"的订阅 record;全部用尽返回 null。
   */
  selectForFailover(q: FailoverQuery): AccessKeyRecord | null {
    const candidates = this.store.listByCustomerSorted(q.customerId);
    for (const cand of candidates) {
      // 闸①② bucketLimits + weekly(只读预检)
      const pre = this.store.precheckRecord(cand, { ...q.precheckOptions, enforceLimit: true });
      if (!pre.allowed) continue;
      // 闸③ fair-share —— 仅当该订阅绑了上游母号(各订阅用各自的 boundAccountId)
      const boundId = this.store.boundAccountIdFor(cand, q.providerId);
      if (boundId > 0 && this.fairShareTracker) {
        const fs = this.fairShareTracker.checkFairShare(boundId, cand.id, q.bucket);
        if (!fs.allowed) continue;
      }
      return cand;
    }
    return null;
  }
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd apps/server && pnpm vitest run src/leasing/lease-core/__tests__/subscription-scheduler.spec.ts`
Expected: PASS(4 个 case)。

- [ ] **Step 5: 验类型 + Commit**

```bash
cd apps/server && pnpm lint
git add apps/server/src/leasing/lease-core/subscription-scheduler.ts apps/server/src/leasing/lease-core/__tests__/subscription-scheduler.spec.ts
git commit -m "feat(server): SubscriptionScheduler — 账户级订阅优先级接力(只读预检)"
```

---

## Task B6: `leaseToken` 集成接力 + `activeSubscriptionId`(集成 TDD)

**Files:**
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts`(import + 字段 + leaseToken ~436 后插入 + 返回体 ~586)
- Test: `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts`

> 接力语义:`resolveFromRequest` 照常拿到 `auth`。若 `auth.record.customerId` 存在(订阅卡)→ 调 scheduler 按 priority 选第一个有额度的订阅替换 `auth.record`;选不到 → 429「账户所有订阅额度已用尽」。文件卡(无 customerId)保持原 `auth.limitExceeded → 429` 逻辑。返回体加 `activeSubscriptionId`。

- [ ] **Step 1: 写失败集成测试** —— 在 `lease-service.spec.ts` 内加 case。注册两个同账户订阅(s1 priority 1 桶满、s2 priority 2 有额度),验证接力到 s2 且回传 activeSubscriptionId:
```typescript
  it("订阅接力:优先订阅桶满 → 自动切到下一个有额度的订阅", async () => {
    const { AccessKeyStore } = await import("../../token-server/access-key-store");
    const store = new AccessKeyStore(accessKeysFilePath);
    store.loadSubscriptionRecords([
      // s1 优先级最高,但 codex-gpt 桶已满(limit=1,已用 1)
      { id: "s1", key: "s1-key", customerId: "cust-1", priority: 1, status: "active", products: ["codex"],
        bucketLimits: { "codex-gpt": 1 }, windowMs: 18_000_000,
        tokenUsageEvents: [{ at: new Date().toISOString(), status: 200, bucket: "codex-gpt", totalTokens: 5 }] },
      // s2 次优先,额度充足
      { id: "s2", key: "s2-key", customerId: "cust-1", priority: 2, status: "active", products: ["codex"],
        bucketLimits: { "codex-gpt": 100000 }, windowMs: 18_000_000 },
    ]);
    const service = withSessionResolver(new LeaseService(
      makeFakeProvider(accountsFilePath, refreshToken),
      { accessKeysFilePath, accessKeyStore: store, now: () => Date.now(), randomId: () => "lease-fixed", minClientVersion: "" },
    ));
    refreshToken.mockResolvedValue("tok");
    // 客户端登录态指向 s1,但 s1 满 → 接力到 s2
    const lease: any = await service.leaseToken(sessionReqFor("s1"), { clientId: "c1", modelKey: "gpt-5-codex" });

    expect(lease.ok).toBe(true);
    expect(lease.activeSubscriptionId).toBe("s2"); // 接力选中 s2
  });

  it("账户所有订阅都满 → 429", async () => {
    const { AccessKeyStore } = await import("../../token-server/access-key-store");
    const store = new AccessKeyStore(accessKeysFilePath);
    store.loadSubscriptionRecords([
      { id: "s1", key: "s1-key", customerId: "cust-1", priority: 1, status: "active", products: ["codex"],
        bucketLimits: { "codex-gpt": 1 }, windowMs: 18_000_000,
        tokenUsageEvents: [{ at: new Date().toISOString(), status: 200, bucket: "codex-gpt", totalTokens: 5 }] },
    ]);
    const service = withSessionResolver(new LeaseService(
      makeFakeProvider(accountsFilePath, refreshToken),
      { accessKeysFilePath, accessKeyStore: store, now: () => Date.now(), randomId: () => "lease-fixed", minClientVersion: "" },
    ));
    refreshToken.mockResolvedValue("tok");
    await expect(service.leaseToken(sessionReqFor("s1"), { clientId: "c1", modelKey: "gpt-5-codex" }))
      .rejects.toMatchObject({ statusCode: 429 });
  });
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/server && pnpm vitest run src/leasing/lease-core/__tests__/lease-service.spec.ts -t "订阅接力|所有订阅都满"`
Expected: FAIL —— 还没接力逻辑:第一个 case `activeSubscriptionId` undefined(或被 s1 的 limitExceeded 直接 429),第二个 case 错误码可能不符。

- [ ] **Step 3a: import + 字段 + lazy-init** —— `lease-service.ts` 顶部 import:
```typescript
import { SubscriptionScheduler } from "./subscription-scheduler";
```
类成员(在 `private readonly fairShareTracker` 附近)加:
```typescript
  private subscriptionScheduler: SubscriptionScheduler | null = null;
```
加一个 lazy-init 私有方法(在类内合适处):
```typescript
  private ensureScheduler(): SubscriptionScheduler {
    if (!this.subscriptionScheduler) {
      this.subscriptionScheduler = new SubscriptionScheduler(this.accessKeyStore, this.fairShareTracker);
    }
    return this.subscriptionScheduler;
  }
```

- [ ] **Step 3b: leaseToken 插入接力** —— 在 `if (!auth.record) throw ...`(~436)之后、`boundAccountId = ...`(~443)之前插入:
```typescript
    if (!auth.record) throw this.fail(401, auth.error || "Unauthorized");

    // ── 账户级订阅优先级接力 ──────────────────────────────────────────────
    // 订阅卡(有 customerId):按 priority 在该账户的订阅间选第一个该 bucket 有额度的,
    // 替换 auth.record。优先订阅用完会自动切到下一个;全部用尽则 429。
    // 文件卡(无 customerId)不接力,沿用下方原 limitExceeded 逻辑。
    if (auth.record.customerId) {
      const bucket = bucketKey(this.provider.id, modelKey);
      const picked = this.ensureScheduler().selectForFailover({
        customerId: auth.record.customerId,
        providerId: this.provider.id,
        modelKey,
        bucket,
        precheckOptions: {
          modelKey,
          product: this.provider.id,
          alignedResetAt: (rec: any) => this.boundAccountResetAt(rec, modelKey),
          weeklyRatio: (rec: any) => this.weeklyRatioForFamily(rec, familyOfBucket(bucket)),
        },
      });
      if (picked) {
        auth.record = picked;
        auth.limitExceeded = false; // 接力已重选有额度的订阅
      } else {
        throw this.fail(429, "账户所有订阅额度已用尽，请稍后再试");
      }
    }
```
> ⚠️ `bucketKey` / `familyOfBucket` / `boundAccountResetAt` / `weeklyRatioForFamily` 在本文件已 import/定义(leaseToken 下游已用到,见 ~459/596 行附近);若某个名字不在作用域,按下游既有调用对齐(搜索文件内现成用法)。

- [ ] **Step 3c: 返回体加 activeSubscriptionId** —— 返回对象(~586,`leaseId` 后)加:
```typescript
      ok: true,
      leaseId: lease.leaseId,
      activeSubscriptionId: auth.record.id,
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd apps/server && pnpm vitest run src/leasing/lease-core/__tests__/lease-service.spec.ts -t "订阅接力|所有订阅都满"`
Expected: PASS。

- [ ] **Step 5: 跑全 lease-core + 验类型(防回归)**

Run: `cd apps/server && pnpm vitest run src/leasing/lease-core && pnpm lint`
Expected: 全 PASS(既有单订阅/文件卡 case 不受影响 —— 文件卡无 customerId 跳过接力;单订阅账户接力选中它自己);tsc EXIT 0。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/leasing/lease-core/lease-service.ts apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts
git commit -m "feat(server): leaseToken 账户化 — 订阅优先级自动接力 + 回传 activeSubscriptionId"
```

---

## 验收(子计划 B 完成定义)
- 账户有多个订阅时,`leaseToken` 按 `priority` 选第一个该 bucket 有额度的订阅;优先订阅用完自动切下一个;全部用尽 429。
- 接力按产品/bucket 独立(s1 的 claude 满切 s2,不影响 s1 的 codex);各订阅用各自 `boundAccountId` 做 fair-share 预检(不限同母号)。
- 单订阅账户、文件卡行为不变;复用现有 `SubscriptionExpiryService`,**零新增定时任务**。
- `cd apps/server && pnpm vitest run src/leasing/lease-core src/leasing/token-server src/leasing/subscription` 全绿;`pnpm lint` EXIT 0。
- **不含**:前端展示/选优先级(子计划 C)、客户端按 activeSubscriptionId 切换 UI(C)。B 只保证后端接力正确 + 回传 activeSubscriptionId。

## Self-Review
- **Spec 覆盖**:覆盖 spec §4.2(leaseToken 账户化 + SubscriptionScheduler 接力 + 回传 activeSubscriptionId)。priority 链(B1/B2)是 §4.2 接力的前置;过期回收复用 SubscriptionExpiryService(§已确认零新增定时任务)。前端(§4.4)归子计划 C。
- **占位符**:无 TODO;B6-Step3b 的"若某名字不在作用域按既有用法对齐"是集成时的接缝核对,非代码占位(下游已有这些调用)。
- **类型一致**:`priority?: number` 在 SubscriptionRow/AccessKeyRecord 一致;`precheckRecord` 返回 `{allowed, resetMs?, reason?}` 与 scheduler 消费一致;`selectForFailover(FailoverQuery)` 返回 `AccessKeyRecord | null` 与 leaseToken 消费一致;scheduler 构造的 `store` 用 `Pick<AccessKeyStore, ...>` 与实际方法名(listByCustomerSorted/precheckRecord/boundAccountIdFor)一致。
