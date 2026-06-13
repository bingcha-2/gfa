# 子计划 A：后端地基 — 用量按账户归属(customerId) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每条用量明细(`CardTokenUsage`)带上归属账户 `customerId`,并给 `Subscription` 加 `priority`(为后续接力铺路) —— 用量从此能按账户查。

**Architecture:** `customerId` 做成冗余列,在**写入时**填(不在查询时 join)。来源链:`EntitlementSync`/boot 注册订阅 record 时把 `Subscription.customerId` 带进内存 `AccessKeyRecord.customerId` → `reportResult` 写入点直接读 `auth.record.customerId`。文件卡(纯池卡)无 customerId → 留 null(对应"无主卡",符合 A 渐进迁移)。

**Tech Stack:** NestJS + Prisma(SQLite) + Vitest;pnpm workspace(`@gfa/server`)。

> ⚠️ **守"server 验证盲区"**:`.spec.ts` 不进 `tsc`、vitest 不查类型。**每个 Task 末尾必跑 `cd apps/server && pnpm lint`(= `tsc --noEmit`)** 验类型。测试会继承本地 `.env`(读 env 的逻辑须 `vi.stubEnv` 保持 hermetic)。

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `prisma/schema.prisma` | 数据模型 | `CardTokenUsage` 加 `customerId`+index;`Subscription` 加 `priority` |
| `apps/server/src/leasing/subscription/subscription-config.ts` | 订阅 config → 限额 record | `SubscriptionRow` + `subscriptionToLimitRecord` 带 `customerId` |
| `apps/server/src/leasing/subscription/subscription-config.spec.ts` | 上者单测 | 加 `customerId` 断言 |
| `apps/server/src/leasing/token-server/access-key-store.ts` | 内存卡/订阅 record | `AccessKeyRecord` 接口加 `customerId?` |
| `apps/server/src/leasing/token-server/__tests__/access-key-store.spec.ts` | 上者单测 | 加 customerId 透传 case |
| `apps/server/src/leasing/subscription/entitlement-sync.service.ts` | 订阅同步进内存 | `registerRecord` 传 `customerId` |
| `apps/server/src/leasing/token-server/token-server.service.ts` | boot 加载订阅 | 传 `customerId` |
| `apps/server/src/leasing/token-server/token-usage-tracker.ts` | 用量事件缓冲 | `TokenUsageEvent`+`record` 带 `customerId` |
| `apps/server/src/leasing/token-server/__tests__/token-usage-tracker.spec.ts` | **新建** | tracker 透传 customerId |
| `apps/server/src/leasing/lease-core/lease-service.ts` | 写入点(reportResult) | record 调用填 `customerId` |
| `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts` | 集成测 | 写入点带 customerId case |

---

## Task 1: schema 加 `customerId` / `priority` + migration

**Files:**
- Modify: `prisma/schema.prisma` (CardTokenUsage 458-477, Subscription 635-664)

- [ ] **Step 1: 改 `CardTokenUsage` 加列 + 索引**

在 `model CardTokenUsage` 的 `accountId` 行下方加一行,并在 `@@index` 区加一条:

```prisma
  accountId         Int?                       // Rosetta account that served the request
  customerId        String?                    // Owning account (Customer.id); null for legacy file/pool cards not yet account-bound
```
```prisma
  @@index([accountId, timestamp])
  @@index([customerId, timestamp])
```

- [ ] **Step 2: 改 `Subscription` 加 `priority`**

在 `model Subscription` 的 `weight` 行下方加:

```prisma
  weight              Int                @default(1)
  priority            Int                @default(0)  // Account-internal failover order: lower = used first
```

- [ ] **Step 3: 生成 migration + client**

Run(仓库根):
```bash
pnpm prisma migrate dev --name account_usage_customer_priority && pnpm db:generate
```
Expected: 在 `prisma/migrations/<ts>_account_usage_customer_priority/` 生成 SQL;`Prisma client` 重新生成无错。

- [ ] **Step 4: 验类型(prisma client 已含新字段)**

Run:
```bash
cd apps/server && pnpm lint
```
Expected: PASS(`tsc --noEmit` 无错)。

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(server): CardTokenUsage 加 customerId、Subscription 加 priority(账户化地基)"
```

---

## Task 2: `subscriptionToLimitRecord` 带 customerId(单元 TDD)

**Files:**
- Modify: `apps/server/src/leasing/subscription/subscription-config.ts` (SubscriptionRow ~76-81, subscriptionToLimitRecord 87-100)
- Modify: `apps/server/src/leasing/subscription/subscription-config.spec.ts` (126-181)
- Modify: `apps/server/src/leasing/token-server/access-key-store.ts` (AccessKeyRecord 61-120)
- Test: `apps/server/src/leasing/subscription/subscription-config.spec.ts`

- [ ] **Step 1: 写失败测试**

在 `subscription-config.spec.ts` 的两个 `subscriptionToLimitRecord` case 里,入参加 `customerId`,`toEqual` 期望加 `customerId`。第一个(号池, ~129-153)改为:

```typescript
    const record = subscriptionToLimitRecord({
      id: "sub-1",
      customerId: "cust-1",
      status: "ACTIVE",
      expiresAt,
      config: {
        line: "pool",
        products: ["anthropic"],
        bucketLimits: { "anthropic-claude": 50000 },
        weeklyTokenLimit: 250000,
        deviceLimit: 2,
        windowMs: 18000000,
      },
    });

    expect(record).toEqual({
      id: "sub-1",
      customerId: "cust-1",
      status: "active",
      products: ["anthropic"],
      bucketLimits: { "anthropic-claude": 50000 },
      weeklyTokenLimit: 250000,
      windowMs: 18000000,
      keyExpiresAt: "2026-07-01T00:00:00.000Z",
    });
```

第二个(绑定, ~155-181)同样:入参加 `customerId: "cust-2"`,`toEqual` 加 `customerId: "cust-2"`。

- [ ] **Step 2: 跑测试,确认失败**

Run:
```bash
cd apps/server && pnpm vitest run src/leasing/subscription/subscription-config.spec.ts -t "subscriptionToLimitRecord"
```
Expected: FAIL —— 实际 record 不含 `customerId`,`toEqual` 不匹配。

- [ ] **Step 3: 实现**

`subscription-config.ts` 的 `SubscriptionRow`(~76-81)加字段:

```typescript
  id: string;
  customerId?: string;
  status: string;
  expiresAt: Date | null;
  config: Record<string, any>;
```

`subscriptionToLimitRecord` 的 `base`(~89-95)加 `customerId`:

```typescript
  const base: Record<string, unknown> = {
    id: sub.id,
    customerId: sub.customerId,
    status: sub.status === "ACTIVE" ? "active" : "expired",
    products: config.products,
    windowMs: config.windowMs,
    keyExpiresAt: sub.expiresAt ? sub.expiresAt.toISOString() : undefined,
  };
```

`access-key-store.ts` 的 `AccessKeyRecord` 接口(在 `migratedToCustomerId` 上方,~98)加:

```typescript
  /** Owning account (Customer.id). Set on subscription shadow records by
   *  entitlement-sync; legacy file/pool cards leave it undefined. Used by
   *  reportResult to stamp CardTokenUsage.customerId. */
  customerId?: string;
```

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd apps/server && pnpm vitest run src/leasing/subscription/subscription-config.spec.ts -t "subscriptionToLimitRecord"
```
Expected: PASS。

- [ ] **Step 5: 验类型 + Commit**

```bash
cd apps/server && pnpm lint
git add apps/server/src/leasing/subscription/subscription-config.ts apps/server/src/leasing/subscription/subscription-config.spec.ts apps/server/src/leasing/token-server/access-key-store.ts
git commit -m "feat(server): subscriptionToLimitRecord 输出 customerId、AccessKeyRecord 加 customerId 字段"
```

---

## Task 3: 注册路径把 customerId 带进内存 record + store 透传测试

**Files:**
- Modify: `apps/server/src/leasing/subscription/entitlement-sync.service.ts` (registerRecord 117-125)
- Modify: `apps/server/src/leasing/token-server/token-server.service.ts` (~155-160)
- Test: `apps/server/src/leasing/token-server/__tests__/access-key-store.spec.ts`

- [ ] **Step 1: 写失败测试(store 端到端透传)**

在 `access-key-store.spec.ts` 末尾(最后一个 `})` 之前)加一个 `describe`。它验证"带 customerId 的订阅 record 经 `loadSubscriptionRecords` 后能由 `findById` 取回"——这是写入点 Task 5 拿到 customerId 的前提:

```typescript
describe("订阅 record 的 customerId 透传(账户化地基)", () => {
  it("loadSubscriptionRecords 注册带 customerId 的 record → findById 可取回", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-cust-"));
    const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
    store.loadSubscriptionRecords([
      { id: "sub-9", customerId: "cust-9", status: "active", products: ["codex"] },
    ]);
    expect(store.findById("sub-9")?.customerId).toBe("cust-9");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

> 文件顶部若未引入 `fs`/`os`/`path`/`AccessKeyStore`,照该 spec 现有 import 补齐(多数已具备)。

- [ ] **Step 2: 跑测试,确认通过(store spread 已透传,但锁定行为防回归)**

Run:
```bash
cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/access-key-store.spec.ts -t "customerId 透传"
```
Expected: PASS(`loadSubscriptionRecords` 用 `{ ...rec }` 已带 customerId)。**若 FAIL**,说明 store 丢了该字段,在 `loadSubscriptionRecords` 的 `Object.assign(existing, rec, usage)` / `set(id, {...rec})` 处确认 customerId 未被剔除。

- [ ] **Step 3: 改两个注册调用点传 customerId**

`entitlement-sync.service.ts` 的 `registerRecord`(117-124):

```typescript
  private registerRecord(sub: Subscription, config: Record<string, any>): void {
    const record = subscriptionToLimitRecord({
      id: sub.id,
      customerId: sub.customerId,
      status: sub.status,
      expiresAt: sub.expiresAt,
      config,
    });
    this.accessKeyStore.loadSubscriptionRecords([record as any]);
  }
```

`token-server.service.ts` 的 boot 加载(~160),给 `subscriptionToLimitRecord` 入参加 `customerId: s.customerId`:

```typescript
        subscriptionToLimitRecord({ id: s.id, customerId: s.customerId, status: s.status, expiresAt: s.expiresAt, config: legacyColumnsToConfig(s) }),
```

> ⚠️ 确认该处 `prisma.subscription.findMany` 的 `select`(若有)包含 `customerId`;若用了显式 `select`,补上 `customerId: true`。

- [ ] **Step 4: 跑相关测试 + 验类型**

Run:
```bash
cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/access-key-store.spec.ts src/leasing/subscription && pnpm lint
```
Expected: PASS;`tsc` 无错(`sub.customerId`/`s.customerId` 类型存在)。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/leasing/subscription/entitlement-sync.service.ts apps/server/src/leasing/token-server/token-server.service.ts apps/server/src/leasing/token-server/__tests__/access-key-store.spec.ts
git commit -m "feat(server): 订阅同步把 customerId 带进内存 record(entitlement-sync + boot 加载)"
```

---

## Task 4: `TokenUsageTracker` 透传 customerId(新建单测 TDD)

**Files:**
- Create: `apps/server/src/leasing/token-server/__tests__/token-usage-tracker.spec.ts`
- Modify: `apps/server/src/leasing/token-server/token-usage-tracker.ts` (TokenUsageEvent 12-25, record 42-70)

- [ ] **Step 1: 写失败测试(新文件)**

```typescript
import { describe, expect, it, vi } from "vitest";
import { TokenUsageTracker } from "../token-usage-tracker";

function makePrisma() {
  return { cardTokenUsage: { createMany: vi.fn().mockResolvedValue({ count: 1 }) } };
}

describe("TokenUsageTracker — customerId 透传", () => {
  it("record 带 customerId → 进入队列", () => {
    const tracker = new TokenUsageTracker(makePrisma());
    tracker.record({
      accessKeyId: "sub-1", customerId: "cust-1",
      modelKey: "gpt-5-codex", bucket: "codex-gpt", status: 200,
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
    });
    expect(tracker.getQueueForTesting()[0]).toMatchObject({ accessKeyId: "sub-1", customerId: "cust-1" });
    tracker.destroy();
  });

  it("flush → createMany 收到含 customerId 的行", async () => {
    const prisma = makePrisma();
    const tracker = new TokenUsageTracker(prisma);
    tracker.record({
      accessKeyId: "sub-1", customerId: "cust-1",
      modelKey: "gpt-5-codex", bucket: "codex-gpt", status: 200,
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
    });
    await tracker.flush();
    expect(prisma.cardTokenUsage.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ accessKeyId: "sub-1", customerId: "cust-1" })],
    });
    tracker.destroy();
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run:
```bash
cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/token-usage-tracker.spec.ts
```
Expected: FAIL —— `record` 当前忽略 `customerId`(类型上不接受,但 vitest 不查类型,运行时该字段不入队列),队列项无 customerId。

- [ ] **Step 3: 实现**

`token-usage-tracker.ts`:`TokenUsageEvent`(12-25)在 `accessKeyId` 下加 `customerId?: string;`;`record` 的入参类型(42-54)同样加 `customerId?: string;`;`queue.push`(56-69)在 `accessKeyId` 后加 `customerId: event.customerId,`:

```typescript
    this.queue.push({
      accessKeyId: event.accessKeyId,
      customerId: event.customerId,
      accessKeyName: event.accessKeyName,
      accountId: event.accountId,
      // …其余不变
```

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd apps/server && pnpm vitest run src/leasing/token-server/__tests__/token-usage-tracker.spec.ts
```
Expected: PASS。

- [ ] **Step 5: 验类型 + Commit**

```bash
cd apps/server && pnpm lint
git add apps/server/src/leasing/token-server/token-usage-tracker.ts apps/server/src/leasing/token-server/__tests__/token-usage-tracker.spec.ts
git commit -m "feat(server): TokenUsageTracker 透传 customerId 到 CardTokenUsage"
```

---

## Task 5: 写入点填 customerId(集成 TDD)

**Files:**
- Modify: `apps/server/src/leasing/lease-core/lease-service.ts` (写入点 920-936)
- Test: `apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts`

- [ ] **Step 1: 写失败集成测试**

在 `lease-service.spec.ts` 的 `describe("LeaseService (generic core)", …)` 内加一个 case(复用既有 `makeFakeProvider`/`refreshToken`/`accountsFilePath`/`accessKeysFilePath` 夹具)。它注入 spy tracker + 注册一个带 customerId 的池子订阅 record,跑 lease→report,断言写入点带上了 customerId:

```typescript
  it("写入点把订阅 record 的 customerId 带进用量事件", async () => {
    const { AccessKeyStore } = await import("../../token-server/access-key-store");
    const recordSpy = vi.fn();
    const fakeTracker = {
      record: recordSpy, flush: vi.fn(), destroy: vi.fn(), getQueueForTesting: () => [],
    } as any;
    const store = new AccessKeyStore(accessKeysFilePath);
    // 池子订阅 record:无 binding → 走 dynamic pool;带 customerId。
    store.loadSubscriptionRecords([
      { id: "sub-c1", customerId: "cust-42", status: "active", products: ["codex"], durationMs: 60 * 60 * 1000 },
    ]);
    const service = withSessionResolver(new LeaseService(
      makeFakeProvider(accountsFilePath, refreshToken),
      { accessKeysFilePath, accessKeyStore: store, tokenUsageTracker: fakeTracker,
        now: () => Date.now(), randomId: () => "lease-fixed", minClientVersion: "" },
    ));
    refreshToken.mockResolvedValue("tok");
    const req = sessionReqFor("sub-c1");

    const lease = await service.leaseToken(req, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(lease.ok).toBe(true);
    await service.reportResult(req, {
      leaseId: lease.leaseId, status: 200, modelKey: "gpt-5-codex",
      inputTokens: 100, outputTokens: 50, totalTokens: 150,
    });

    expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({
      accessKeyId: "sub-c1", customerId: "cust-42",
    }));
  });
```

> 若 `leaseToken` 返回 `ok:false`(池子订阅 record 缺字段无法 lease),按报错补齐 record 字段(如 `windowMs`/`keyExpiresAt`)直至能 lease —— 目标是让 report 真正抵达写入点。`reportResult` 的 token 字段名以该 spec 既有 report case(`lease-service.spec.ts:153`/`:170`)为准对齐。

- [ ] **Step 2: 跑测试,确认失败**

Run:
```bash
cd apps/server && pnpm vitest run src/leasing/lease-core/__tests__/lease-service.spec.ts -t "customerId 带进用量事件"
```
Expected: FAIL —— 写入点当前未填 customerId,spy 收到的对象无 `customerId`。

- [ ] **Step 3: 实现(写入点填值)**

`lease-service.ts` 写入点(923-935)在 `accessKeyId: cardId,` 后加一行:

```typescript
        this.tokenUsageTracker.record({
          accessKeyId: cardId,
          customerId: (auth.record.customerId as string | undefined),
          accessKeyName: auth.record?.name || undefined,
          accountId: accountId || undefined,
          // …其余不变
```

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd apps/server && pnpm vitest run src/leasing/lease-core/__tests__/lease-service.spec.ts -t "customerId 带进用量事件"
```
Expected: PASS。

- [ ] **Step 5: 跑全套 leasing 测试 + 验类型(防回归)**

Run:
```bash
cd apps/server && pnpm vitest run src/leasing && pnpm lint
```
Expected: 全 PASS;`tsc` 无错。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/leasing/lease-core/lease-service.ts apps/server/src/leasing/lease-core/__tests__/lease-service.spec.ts
git commit -m "feat(server): reportResult 写入点填 customerId — 用量按账户归属(订阅卡有, 文件卡 null)"
```

---

## 验收(子计划 A 完成定义)
- `CardTokenUsage` 有 `customerId` 列与索引;`Subscription` 有 `priority`。
- 经账户订阅(subscription record)产生的用量,`CardTokenUsage.customerId` = 该账户;文件卡/纯池卡为 null。
- `cd apps/server && pnpm vitest run src/leasing` 全绿;`pnpm lint` 无类型错。
- **不含**:历史回填(子计划 D)、portal/console 按账户查(子计划 E)、接力(子计划 B)。本计划只保证"新用量写入即带 customerId"。

## Self-Review
- **Spec 覆盖**:本计划覆盖 spec §4.1(数据模型 customerId/priority)+ §4.6 的"写入填 customerId"。portal/console 聚合(§4.6 其余)归子计划 E;回填(§4.5 B)归子计划 D —— 已在验收里显式划出,无遗漏。
- **占位符**:无 TODO;Task 5 的两处"按报错补齐/对齐字段"是集成测在真实路径上的标准调试动作,非代码占位。
- **类型一致**:`customerId?: string` 在 `SubscriptionRow`/`AccessKeyRecord`/`TokenUsageEvent` 三处签名一致;写入点 `auth.record.customerId` 与 `AccessKeyRecord.customerId` 对应。
