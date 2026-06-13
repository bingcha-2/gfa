# 子计划 C(后端地基)：app-auth 返回订阅数组 + 优先级接口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 后端为前端多订阅展示铺路 —— app 登录/心跳返回**订阅数组**(按 priority,兼容旧 app 的单 subscription 字段),并提供**设置订阅优先级**接口。

**Architecture:** `getActiveSubscription`(findFirst)→ `listActiveSubscriptionsSorted`(findMany 按 priority 升序);`buildSubscriptionSummary` 加 `id`/`priority`;login/heartbeat 返回 `subscription`(=数组首个,兼容)+ `subscriptions[]`(新)。新增 `POST /api/account/subscriptions/priority`(CustomerJwtGuard,改 `Subscription.priority`,返回重排后的列表)。

**Tech Stack:** NestJS + Prisma(SQLite) + Vitest。

> ⚠️ 守"server 验证盲区":每 task 末 `cd apps/server && pnpm lint`(tsc EXIT 0)。IDE `new-diagnostics` 可能陈旧,以 CLI tsc 为准。测试用 `prisma/test.db`(连真实 DB 的 spec);本计划单测可 mock prisma,集成测连 test.db。
>
> **C 的范围说明**:本文件只覆盖 **C 的后端地基**(app/web 前端都依赖它)。C 的 **app 客户端(Go+React)** 和 **web(Next.js)** 是独立子计划,需实际运行验证(app 构建 / web preview),单独推进。

---

## File Structure

| 文件 | 改动 |
|---|---|
| `apps/server/src/leasing/app/app-auth/app-auth.service.ts` | `getActiveSubscription`→`listActiveSubscriptionsSorted`;`buildSubscriptionSummary` 加 id/priority;login/heartbeat 返回 subscriptions[] |
| `apps/server/src/leasing/app/app-auth/__tests__/app-auth.service.spec.ts` | 多订阅返回 case |
| `apps/server/src/leasing/account/portal/portal.service.ts` | 加 `setSubscriptionPriority(customerId, subscriptionId, priority)` |
| `apps/server/src/leasing/account/portal/portal.controller.ts` | 加 `SubscriptionPriorityController`(POST /account/subscriptions/priority) |
| `apps/server/src/leasing/account/portal/__tests__/portal.service.spec.ts` | setSubscriptionPriority case(归属校验 + 重排) |

---

## Task C-B1: app-auth 返回订阅数组(集成 TDD)

**Files:**
- Modify: `apps/server/src/leasing/app/app-auth/app-auth.service.ts`(buildSubscriptionSummary 12-36, getActiveSubscription 47-61, login 158-168, heartbeat 210-216)
- Test: `apps/server/src/leasing/app/app-auth/__tests__/app-auth.service.spec.ts`

- [ ] **Step 1: 写失败测试** —— 参照该 spec 现有 setup(它已有 mock prisma + service 构造,搜索文件里 `new AppAuthService` 或 `beforeEach` 的夹具,照它的 mock 方式)。加一个 case:mock `prisma.subscription.findMany` 返回 2 个订阅(priority 2 和 priority 1),调 `service.login(...)`,断言:
```typescript
    // 期望:subscriptions 数组按 priority 升序(priority 1 在前),且兼容字段 subscription = 数组首个
    expect(result.subscriptions).toHaveLength(2);
    expect(result.subscriptions[0].priority).toBe(1);
    expect(result.subscriptions[0].id).toBeTruthy();
    expect(result.subscription).toEqual(result.subscriptions[0]); // 兼容旧 app
```
> 该 spec 现在 mock 的是 `findFirst`(getActiveSubscription)。改成 mock `findMany`。若 setup 是共享的,新 case 内单独 override `findMany` 的返回。

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/server && pnpm vitest run src/leasing/app/app-auth/__tests__/app-auth.service.spec.ts -t "subscriptions"`
Expected: FAIL —— `result.subscriptions` undefined。

- [ ] **Step 3: 实现**

`buildSubscriptionSummary`(12-36)入参 + 输出加 `id`/`priority`:
```typescript
function buildSubscriptionSummary(subscription: {
  id: string;
  status: string;
  expiresAt: Date | null;
  deviceLimit: number;
  priority: number;
  productEntitlements: string;
} | null) {
  if (!subscription) return null;
  let products: any;
  try { products = JSON.parse(subscription.productEntitlements); } catch { products = []; }
  return {
    id: subscription.id,
    planName: null,
    status: subscription.status,
    expiresAt: subscription.expiresAt,
    deviceLimit: subscription.deviceLimit,
    priority: subscription.priority,
    products,
  };
}
```

`getActiveSubscription`(47-61)改为 `listActiveSubscriptionsSorted`(findMany 按 priority 升序,select 含新字段):
```typescript
  private async listActiveSubscriptionsSorted(customerId: string) {
    const now = new Date();
    return this.prisma.subscription.findMany({
      where: {
        customerId,
        status: "ACTIVE",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { priority: "asc" },
      select: { id: true, status: true, expiresAt: true, deviceLimit: true, priority: true, productEntitlements: true },
    });
  }
```

login 返回(158-168)改为:
```typescript
    const subs = await this.listActiveSubscriptionsSorted(customer.id);
    const subscriptions = subs.map(buildSubscriptionSummary);
    return {
      token,
      tokenExpiresAt,
      account: { email: customer.email, displayName: customer.displayName },
      subscription: subscriptions[0] ?? null, // 兼容旧 app
      subscriptions,                          // 新:全部订阅按 priority
    };
```

heartbeat 返回(210-216)改为:
```typescript
    const subs = await this.listActiveSubscriptionsSorted(dto.customerId);
    const subscriptions = subs.map(buildSubscriptionSummary);
    return {
      ok: true,
      subscription: subscriptions[0] ?? null,
      subscriptions,
      device: { status: "ACTIVE" },
    };
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd apps/server && pnpm vitest run src/leasing/app/app-auth/__tests__/app-auth.service.spec.ts`
Expected: PASS(新 case + 既有 case 全绿 —— 既有 case 若断言了 `result.subscription` 的形状,现在多了 id/priority 字段,可能需同步更新它们的期望)。

- [ ] **Step 5: 验类型 + Commit**

```bash
cd apps/server && pnpm lint
git add apps/server/src/leasing/app/app-auth/app-auth.service.ts apps/server/src/leasing/app/app-auth/__tests__/app-auth.service.spec.ts
git commit -m "feat(server): app-auth login/heartbeat 返回订阅数组(按 priority,兼容单 subscription)"
```

---

## Task C-B2: 设置订阅优先级接口(单元 TDD)

**Files:**
- Modify: `apps/server/src/leasing/account/portal/portal.service.ts`(加 setSubscriptionPriority)
- Modify: `apps/server/src/leasing/account/portal/portal.controller.ts`(加 SubscriptionPriorityController)
- Test: `apps/server/src/leasing/account/portal/__tests__/portal.service.spec.ts`

- [ ] **Step 1: 写失败测试** —— 参照 portal.service.spec.ts 现有 setup(mock prisma)。加 case:
```typescript
describe("setSubscriptionPriority", () => {
  it("改自己订阅的 priority → 更新并返回重排后的列表", async () => {
    // mock prisma.subscription.findUnique 返回 { id:"s1", customerId:"c1" }
    // mock prisma.subscription.update
    // mock prisma.subscription.findMany 返回重排后的 [s1(prio1), s2(prio2)]
    const res = await service.setSubscriptionPriority("c1", "s1", 1);
    expect(res.subscriptions[0].id).toBe("s1");
  });

  it("改不属于自己的订阅 → 抛错(NotFound/Forbidden),不 update", async () => {
    // mock findUnique 返回 { id:"s1", customerId:"OTHER" }
    await expect(service.setSubscriptionPriority("c1", "s1", 1)).rejects.toBeTruthy();
  });
});
```
> 断言细节按 portal.service.spec 现有风格对齐(它怎么 mock prisma、怎么断言)。

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/server && pnpm vitest run src/leasing/account/portal/__tests__/portal.service.spec.ts -t "setSubscriptionPriority"`
Expected: FAIL —— 方法不存在。

- [ ] **Step 3a: portal.service 加方法**
```typescript
  /** 设置某订阅的优先级(账户内接力顺序)。校验订阅属于该 customer,再 update,返回重排后的概览订阅列表。 */
  async setSubscriptionPriority(customerId: string, subscriptionId: string, priority: number) {
    const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId }, select: { id: true, customerId: true } });
    if (!sub || sub.customerId !== customerId) {
      throw new NotFoundException({ error: "SUBSCRIPTION_NOT_FOUND", message: "订阅不存在或不属于当前账户" });
    }
    await this.prisma.subscription.update({ where: { id: subscriptionId }, data: { priority: Math.max(0, Math.floor(Number(priority) || 0)) } });
    const overview = await this.getOverview(customerId);
    return { ok: true, subscriptions: overview.subscriptions };
  }
```
> `NotFoundException` 从 `@nestjs/common` import(文件顶部若没有则补)。`getOverview` 是本 service 既有方法(返回 subscriptions[] 含 quota)。

- [ ] **Step 3b: portal.controller 加 controller** —— 在文件末尾(UsageController 后)加:
```typescript
import { Body, Post } from "@nestjs/common"; // 顶部 import 合并进现有的 @nestjs/common 那行

@Controller("account/subscriptions")
@Public()
@UseGuards(CustomerJwtGuard)
export class SubscriptionPriorityController {
  constructor(private readonly portalService: PortalService) {}

  /** POST /api/account/subscriptions/priority  body: { subscriptionId, priority } */
  @Post("priority")
  setPriority(
    @CurrentCustomer() customer: CustomerUser,
    @Body() body: { subscriptionId: string; priority: number },
  ) {
    return this.portalService.setSubscriptionPriority(customer.customerId, body.subscriptionId, Number(body.priority));
  }
}
```
> ⚠️ 把新 controller 注册进 module:搜 `PortalController` 在哪个 `@Module` 的 `controllers:` 数组里(应在 portal.module.ts 或 account 模块),把 `SubscriptionPriorityController` 也加进去,否则路由不生效。

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd apps/server && pnpm vitest run src/leasing/account/portal/__tests__/portal.service.spec.ts -t "setSubscriptionPriority"`
Expected: PASS。

- [ ] **Step 5: 跑全 account 回归 + 验类型**

Run: `cd apps/server && pnpm vitest run src/leasing/account src/leasing/app && pnpm lint`
Expected: 全 PASS;tsc EXIT 0。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/leasing/account/portal/portal.service.ts apps/server/src/leasing/account/portal/portal.controller.ts apps/server/src/leasing/account/portal/__tests__/portal.service.spec.ts apps/server/src/leasing/account/portal/portal.module.ts
git commit -m "feat(server): POST /account/subscriptions/priority — 设置订阅优先级(账户接力顺序)"
```

---

## 验收(C 后端地基完成定义)
- `POST /api/app/login`、`/heartbeat` 返回 `subscriptions[]`(按 priority 升序)+ 兼容字段 `subscription`(=首个)。
- `POST /api/account/subscriptions/priority` 可改 `Subscription.priority`(校验归属),返回重排后列表。
- `cd apps/server && pnpm vitest run src/leasing/app src/leasing/account` 全绿;`pnpm lint` EXIT 0。
- **不含**:app 客户端(Go+React)、web(Next.js)前端 —— 独立子计划,需实际运行验证。

## Self-Review
- 覆盖 spec §4.4 后端部分(app-auth 数组 + 优先级接口)。app/web 前端归 C-app / C-web 子计划。
- 占位符:测试 setup"参照现有 spec"指向真实存在的 `app-auth.service.spec.ts` / `portal.service.spec.ts` 夹具,断言要点完整给出。
- 类型一致:`buildSubscriptionSummary` 加 id/priority 入参与 `listActiveSubscriptionsSorted` 的 select 一致;`setSubscriptionPriority` 返回 `{ok, subscriptions}` 与 controller 一致。
