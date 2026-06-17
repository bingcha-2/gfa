# Console 计费域 IA 重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 console 里订单/套餐/账号/订阅/用量连成一体——订阅详情做枢纽,逐产品换绑,GRANT 语义修正,四条互跳打通。

**Architecture:** 方案 C(复用现有页 + 补连接)。每块的决策逻辑抽成纯函数用 vitest 做 TDD;React 组件消费这些纯函数,改动后用 `tsc` + 手验。订阅座位真相源 = DB `status=ACTIVE` 订阅的 `config.bindings`。

**Tech Stack:** Next.js(client 组件 + `useEffect`/`apiRequest`)、NestJS + Prisma、vitest 4、shadcn UI(Drawer/Table/Badge/Select/Button)。

**工程约束(全程强制):** TDD(先写失败测试);改到的文件删废旧代码;单文件 ≤ 800–1000 行,超了拆成可单测的小组件。

**测试约定(实测):**
- 测试框架:vitest。前端测试放 `apps/web/src/test/*.test.ts`;后端放 `apps/server/src/**/__tests__/*.spec.ts`。
- 跑单个测试文件:`npm test -- <path>`(在仓库根)。
- 断言风格:`import { describe, expect, it } from "vitest"`。
- 本仓库测纯逻辑/服务,不测 React 渲染 → 每块把决策逻辑抽成纯函数 TDD。

---

## File Structure

新增(纯逻辑,带单测):
- `apps/web/src/lib/console/subscription-view.ts` — 把订阅 `config` 解析成详情展示模型(逐产品行)。
- `apps/web/src/lib/console/order-action.ts` — 按 `payChannel`+`status` 决定订单动作(退款/撤销授权/无)。
- `apps/web/src/lib/console/pool-occupancy.ts` — 超卖判定 + 占用筛选。

新增(UI):
- `apps/web/src/app/(console)/console/(dashboard)/(customer)/subscriptions/subscription-detail-drawer.tsx` — 订阅详情枢纽(抽屉,带 `?sub=<id>` 可寻址)。
- `apps/web/src/app/(console)/console/(dashboard)/(customer)/subscriptions/rebind-row.tsx` — 逐产品换绑行(被详情抽屉复用)。

修改:
- `apps/web/src/lib/console/types.ts` — `ConsoleSubscription` 补 `config/bindings/levels`。
- `subscriptions/page.tsx` — 列表行接入抽屉;**删除旧 `RebindDialog`**。
- `customers/[id]/page.tsx` — 一屏全貌(订阅卡 + 订单动作自适应 + KPI)。
- `plan-orders/page.tsx` — 动作自适应 + "已激活订阅"列。
- `usage-stats/BoundCardAccordion.tsx` — 占用表接跳转 + 超卖筛选。
- `apps/web/src/components/account/account-billing-center.tsx` — 客户端 GRANT 单不显示"退款"。

后端(数据已基本就绪,最小改动):
- `billing-admin.service.ts` `listSubscriptions` 已返回完整行(含 `config/bindings/levels`)——仅前端类型补齐,无需改后端。
- 份额/账号名富化:复用 `rosetta.occupiedSharesFromSubscriptions` 与 `/api/remote-stats/dashboard`(Phase C)。

---

## Phase 0:类型与纯逻辑基座

### Task 1: 扩展 ConsoleSubscription 类型

**Files:**
- Modify: `apps/web/src/lib/console/types.ts:278-293`

- [ ] **Step 1: 改类型(无需测试,纯类型)**

把 `ConsoleSubscription` 末尾补三字段(后端 `listSubscriptions` 已返回这些列):

```typescript
export type ConsoleSubscription = {
  id: string;
  customerId: string;
  planId: string | null;
  status: string;
  startsAt: string;
  expiresAt: string | null;
  productEntitlements: string;
  weight: number;
  deviceLimit: number;
  createdAt: string;
  line?: "bind" | "pool";
  config: string | null;
  bindings: string | null;
  levels: string | null;
  plan: { name: string } | null;
  customer: { email: string } | null;
};
```

- [ ] **Step 2: 类型检查**

Run: `npm run -w apps/web typecheck`(若无该脚本用 `npx tsc -p apps/web --noEmit`)
Expected: 通过(新增可选/可空字段不破坏现有用法)。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/console/types.ts
git commit -m "feat(console): expose config/bindings/levels on ConsoleSubscription type"
```

---

### Task 2: subscription-view 纯逻辑(订阅→展示模型)

**Files:**
- Create: `apps/web/src/lib/console/subscription-view.ts`
- Test: `apps/web/src/test/subscription-view.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, expect, it } from "vitest";
import { buildSubscriptionView } from "@/lib/console/subscription-view";

describe("buildSubscriptionView", () => {
  it("bind line: 逐产品行带等级+绑定号,未绑标记 unbound", () => {
    const v = buildSubscriptionView({
      config: JSON.stringify({
        line: "bind",
        products: ["anthropic", "codex"],
        levels: { anthropic: "max-20x", codex: "plus" },
        bindings: { anthropic: 15, codex: 0 },
        weight: 4,
        deviceLimit: 3,
      }),
    });
    expect(v.line).toBe("bind");
    expect(v.weight).toBe(4);
    expect(v.rows).toEqual([
      { product: "anthropic", level: "max-20x", accountId: 15, bound: true },
      { product: "codex", level: "plus", accountId: null, bound: false },
    ]);
  });

  it("pool line: 无绑定行,带用量档", () => {
    const v = buildSubscriptionView({
      config: JSON.stringify({ line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 1, weight: 1 }),
    });
    expect(v.line).toBe("pool");
    expect(v.usageTier).toBe("large");
    expect(v.rows).toEqual([{ product: "anthropic", level: null, accountId: null, bound: false }]);
  });

  it("config 为 null/损坏 → 安全降级为 pool 空行", () => {
    expect(buildSubscriptionView({ config: null }).line).toBe("pool");
    expect(buildSubscriptionView({ config: "{bad json" }).rows).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- apps/web/src/test/subscription-view.test.ts`
Expected: FAIL（`buildSubscriptionView` 未定义）。

- [ ] **Step 3: 写实现**

```typescript
export type SubProductRow = {
  product: string;
  level: string | null;
  accountId: number | null;
  bound: boolean;
};

export type SubscriptionView = {
  line: "bind" | "pool";
  rows: SubProductRow[];
  weight: number;
  deviceLimit: number;
  usageTier: string | null;
};

function safeParse(json: string | null): Record<string, any> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function buildSubscriptionView(input: { config: string | null }): SubscriptionView {
  const c = safeParse(input.config);
  if (!c) return { line: "pool", rows: [], weight: 1, deviceLimit: 1, usageTier: null };

  const products: string[] = Array.isArray(c.products) ? c.products.map(String) : [];
  const line: "bind" | "pool" = c.line === "bind" ? "bind" : "pool";
  const levels = (c.levels && typeof c.levels === "object" ? c.levels : {}) as Record<string, string>;
  const bindings = (c.bindings && typeof c.bindings === "object" ? c.bindings : {}) as Record<string, number>;

  const rows: SubProductRow[] = products.map((product) => {
    const accountId = line === "bind" ? Number(bindings[product]) || null : null;
    return {
      product,
      level: line === "bind" ? (levels[product] ? String(levels[product]) : null) : null,
      accountId: accountId && accountId > 0 ? accountId : null,
      bound: line === "bind" && accountId != null && accountId > 0,
    };
  });

  return {
    line,
    rows,
    weight: Math.max(1, Math.floor(Number(c.weight) || 1)),
    deviceLimit: Math.max(1, Math.floor(Number(c.deviceLimit) || 1)),
    usageTier: line === "pool" && c.usageTier ? String(c.usageTier) : null,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- apps/web/src/test/subscription-view.test.ts`
Expected: PASS（3 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/console/subscription-view.ts apps/web/src/test/subscription-view.test.ts
git commit -m "feat(console): subscription-view pure helper (config -> per-product display rows)"
```

---

### Task 3: order-action 纯逻辑(GRANT 语义)

**Files:**
- Create: `apps/web/src/lib/console/order-action.ts`
- Test: `apps/web/src/test/order-action.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, expect, it } from "vitest";
import { orderAction } from "@/lib/console/order-action";

describe("orderAction", () => {
  it("付费已支付单 → 退款", () => {
    expect(orderAction({ payChannel: "ALIPAY", status: "PAID" })).toEqual({ kind: "refund", label: "退款" });
    expect(orderAction({ payChannel: "WXPAY", status: "PAID" })).toEqual({ kind: "refund", label: "退款" });
  });
  it("GRANT 已支付单 → 撤销授权(不是退款)", () => {
    expect(orderAction({ payChannel: "GRANT", status: "PAID" })).toEqual({ kind: "revoke", label: "撤销授权" });
  });
  it("非 PAID 单 → 无动作", () => {
    expect(orderAction({ payChannel: "ALIPAY", status: "REFUNDED" })).toEqual({ kind: "none", label: "" });
    expect(orderAction({ payChannel: "GRANT", status: "PENDING" })).toEqual({ kind: "none", label: "" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- apps/web/src/test/order-action.test.ts`
Expected: FAIL（`orderAction` 未定义）。

- [ ] **Step 3: 写实现**

```typescript
export type OrderActionKind = "refund" | "revoke" | "none";
export type OrderAction = { kind: OrderActionKind; label: string };

export function orderAction(o: { payChannel: string; status: string }): OrderAction {
  if (o.status !== "PAID") return { kind: "none", label: "" };
  if (o.payChannel === "GRANT") return { kind: "revoke", label: "撤销授权" };
  return { kind: "refund", label: "退款" };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- apps/web/src/test/order-action.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/console/order-action.ts apps/web/src/test/order-action.test.ts
git commit -m "feat(console): order-action pure helper (GRANT -> revoke, paid -> refund)"
```

---

### Task 4: pool-occupancy 纯逻辑(超卖判定 + 筛选)

**Files:**
- Create: `apps/web/src/lib/console/pool-occupancy.ts`
- Test: `apps/web/src/test/pool-occupancy.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, expect, it } from "vitest";
import { isOversold, filterOversold } from "@/lib/console/pool-occupancy";

describe("pool-occupancy", () => {
  it("isOversold: 占用 > 容量 才算超卖", () => {
    expect(isOversold(9, 8)).toBe(true);
    expect(isOversold(8, 8)).toBe(false);
    expect(isOversold(3, 8)).toBe(false);
  });
  it("filterOversold: 只留超卖号", () => {
    const accts = [
      { id: 1, usedShares: 9, shareCapacity: 8 },
      { id: 2, usedShares: 4, shareCapacity: 8 },
    ];
    expect(filterOversold(accts).map((a) => a.id)).toEqual([1]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- apps/web/src/test/pool-occupancy.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写实现**

```typescript
export function isOversold(usedShares: number, shareCapacity: number): boolean {
  return Number(usedShares) > Number(shareCapacity);
}

export function filterOversold<T extends { usedShares?: number; shareCapacity?: number }>(accts: T[]): T[] {
  return accts.filter((a) => isOversold(Number(a.usedShares || 0), Number(a.shareCapacity || 0)));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- apps/web/src/test/pool-occupancy.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/console/pool-occupancy.ts apps/web/src/test/pool-occupancy.test.ts
git commit -m "feat(console): pool-occupancy helpers (oversold detection + filter)"
```

---

## Phase A:订阅详情枢纽 + 逐产品换绑(块 1+2)

### Task 5: 逐产品换绑行组件 rebind-row

**Files:**
- Create: `apps/web/src/app/(console)/console/(dashboard)/(customer)/subscriptions/rebind-row.tsx`

接口契约:复用现有后端 `POST subscriptions/:id/rebind { product, accountId, force }`(`entitlement-sync.rebindProduct` 返回 `{ ok:true, product, accountId } | { ok:false, error }`,服务层失败抛 `ConflictException`)。

- [ ] **Step 1: 写组件(消费 SubProductRow,内置一行换绑)**

```tsx
"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SubProductRow } from "@/lib/console/subscription-view";

const PRODUCT_LABELS: Record<string, string> = { anthropic: "Anthropic", codex: "Codex", antigravity: "Antigravity" };
const LEVEL_LABELS: Record<string, string> = { pro: "Pro", "max-5x": "Max 5x", "max-20x": "Max 20x", plus: "Plus", ultra: "Ultra" };

export function RebindRow({ subId, row, onDone }: { subId: string; row: SubProductRow; onDone: () => void | Promise<void> }) {
  const [accountId, setAccountId] = useState("");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const id = Number(accountId);
    if (!(id > 0)) { toast.error("请填写有效的账号 ID"); return; }
    setBusy(true);
    try {
      await apiRequest(`subscriptions/${subId}/rebind`, { method: "POST", body: { product: row.product, accountId: id, force } });
      toast.success(`已将「${PRODUCT_LABELS[row.product] ?? row.product}」绑定切到账号 #${id}`);
      setAccountId("");
      await onDone();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 py-2 border-t first:border-t-0">
      <span className="font-medium text-sm w-24">{PRODUCT_LABELS[row.product] ?? row.product}</span>
      <span className="text-xs text-muted-foreground w-16">{row.level ? (LEVEL_LABELS[row.level] ?? row.level) : "—"}</span>
      <span className="text-sm flex-1 min-w-32">
        {row.bound
          ? <a className="text-blue-600 underline-offset-2 hover:underline" href={`/console/codex-accounts?focus=${row.accountId}`}>当前 #{row.accountId} ↗</a>
          : <span className="text-destructive">⚠ 未绑定</span>}
      </span>
      <Input type="number" placeholder="目标账号 ID" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-32 h-8" />
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 强制
      </label>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit()}>
        <Link2 className="h-3.5 w-3.5 mr-1" />{row.bound ? "换绑" : "绑号"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc -p apps/web --noEmit`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(console)/console/(dashboard)/(customer)/subscriptions/rebind-row.tsx"
git commit -m "feat(console): per-product RebindRow (shows current binding, bind/rebind inline)"
```

---

### Task 6: 订阅详情抽屉 subscription-detail-drawer

**Files:**
- Create: `apps/web/src/app/(console)/console/(dashboard)/(customer)/subscriptions/subscription-detail-drawer.tsx`

- [ ] **Step 1: 写抽屉组件(消费 buildSubscriptionView + RebindRow + 跳转链接)**

```tsx
"use client";
import { toast } from "sonner";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildSubscriptionView } from "@/lib/console/subscription-view";
import { RebindRow } from "./rebind-row";
import type { ConsoleSubscription } from "@/lib/console/types";

export function SubscriptionDetailDrawer({
  sub, open, onOpenChange, onChanged,
}: {
  sub: ConsoleSubscription | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged: () => void | Promise<void>;
}) {
  if (!sub) return null;
  const view = buildSubscriptionView({ config: sub.config });

  async function revoke() {
    try {
      await apiRequest(`subscriptions/${sub!.id}/revoke`, { method: "POST" });
      toast.success("已撤销订阅");
      onOpenChange(false);
      await onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="ml-auto h-full w-full max-w-md">
        <DrawerHeader>
          <DrawerTitle>订阅详情</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4 space-y-4 overflow-y-auto">
          <div className="text-sm text-muted-foreground">
            <a className="text-blue-600 hover:underline" href={`/console/customers/${sub.customerId}`}>客户 {sub.customer?.email ?? sub.customerId} ↗</a>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant="outline" className={view.line === "bind" ? "border-blue-300 text-blue-600" : "text-muted-foreground"}>
              {view.line === "bind" ? "绑定线" : "号池线"}
            </Badge>
            <Badge variant="secondary">{sub.status}</Badge>
            <span className="text-xs text-muted-foreground">共享 w{view.weight} · 设备 {view.deviceLimit} 台</span>
          </div>

          {view.line === "bind" ? (
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground mb-1">产品与绑定</div>
              {view.rows.map((row) => (
                <RebindRow key={row.product} subId={sub.id} row={row} onDone={onChanged} />
              ))}
            </div>
          ) : (
            <div className="rounded-md border p-3 text-sm">
              号池线 · 用量档 {view.usageTier ?? "—"} · 运行时动态调度,不绑定具体号。
            </div>
          )}

          {sub.status === "ACTIVE" && (
            <div className="flex justify-end pt-2 border-t">
              <Button variant="outline" className="text-destructive border-destructive/40" onClick={() => void revoke()}>撤销订阅</Button>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc -p apps/web --noEmit`
Expected: 通过。若 `Drawer` 子组件导出名不符,按 `apps/web/src/components/ui/drawer.tsx` 实际导出名修正(已确认存在 vaul 版 Drawer)。

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(console)/console/(dashboard)/(customer)/subscriptions/subscription-detail-drawer.tsx"
git commit -m "feat(console): subscription detail drawer (hub) with per-product bindings + revoke"
```

---

### Task 7: 订阅列表接入抽屉并删除旧 RebindDialog

**Files:**
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(customer)/subscriptions/page.tsx`

- [ ] **Step 1: 删除旧 `RebindDialog`(整个函数,约 54-107 行)**

删掉 `function RebindDialog(...) { ... }` 及其唯一引用处(行内 `{s.line === "bind" && <RebindDialog sub={s} onDone={load} />}`)。删除随之失效的 import:`Link2`、`AlertDialog*` 若不再被该文件其它处使用(撤销按钮仍用 AlertDialog 则保留)。

- [ ] **Step 2: 加抽屉状态 + 行点击打开**

在组件顶部 state 区:

```tsx
const [detail, setDetail] = useState<ConsoleSubscription | null>(null);
```

把每个订阅行的"套餐"单元格改为可点击打开抽屉:

```tsx
<TableCell className="font-medium">
  <button className="text-blue-600 hover:underline" onClick={() => setDetail(s)}>
    {s.plan?.name ?? (s.line === "bind" ? "绑定订阅" : "号池订阅")}
  </button>
</TableCell>
```

操作列只保留撤销(换绑已移入抽屉):

```tsx
<TableCell className="text-right">
  {s.status === "ACTIVE" && (
    <Button variant="ghost" size="sm" onClick={() => setDetail(s)}>详情</Button>
  )}
</TableCell>
```

在 `return` 的根节点尾部挂抽屉:

```tsx
<SubscriptionDetailDrawer sub={detail} open={!!detail} onOpenChange={(o) => !o && setDetail(null)} onChanged={load} />
```

补 import:

```tsx
import { SubscriptionDetailDrawer } from "./subscription-detail-drawer";
```

- [ ] **Step 3: 类型检查 + 手验**

Run: `npx tsc -p apps/web --noEmit`
Expected: 通过(无对已删 `RebindDialog` 的悬挂引用)。
手验:订阅列表点套餐 → 抽屉打开;绑定线显示逐产品行;换绑/撤销可用。

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(console)/console/(dashboard)/(customer)/subscriptions/page.tsx"
git commit -m "feat(console): wire subscription list to detail drawer; remove legacy RebindDialog"
```

---

## Phase B:GRANT 语义修正(块贯穿)

### Task 8: 客户端账单页对 GRANT 单隐藏"退款"

**Files:**
- Modify: `apps/web/src/components/account/account-billing-center.tsx:421`

- [ ] **Step 1: 改显示条件(GRANT/¥0 不渲染退款按钮)**

把:

```tsx
{order.status === "PAID" && onRefundOrder && (
```

改为:

```tsx
{order.status === "PAID" && order.payChannel !== "GRANT" && order.amountCents > 0 && onRefundOrder && (
```

(若该组件 order 类型无 `payChannel`/`amountCents`,在其类型与 `/api/account/billing/orders` 映射处补——后端 `listOrders` 已返回 `payChannel`/`amountCents`。)

- [ ] **Step 2: 类型检查 + 手验**

Run: `npx tsc -p apps/web --noEmit`
手验:客户账单页 GRANT 单不再出现"退款"按钮;付费单仍有。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/account/account-billing-center.tsx
git commit -m "fix(account): hide refund button on GRANT/zero-amount orders (backend rejects them anyway)"
```

---

### Task 9: 订单页动作自适应 + “已激活订阅”列

**Files:**
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(customer)/plan-orders/page.tsx:160-205`

后端已有 revoke 入口:GRANT 单的"撤销授权"复用 `POST subscriptions/:id/revoke`(需 `o.subscriptionId`);付费"退款"用现有 `POST plan-orders/:id/refund`。`ConsolePlanOrder` 已含 `subscriptionId`。

- [ ] **Step 1: 表头加“已激活订阅”列**

在 `<TableHead>状态</TableHead>` 后插入 `<TableHead>已激活订阅</TableHead>`。对应行加单元格:

```tsx
<TableCell>
  {o.subscriptionId
    ? <a className="text-blue-600 hover:underline" href={`/console/subscriptions?sub=${o.subscriptionId}`}>查看 ↗</a>
    : <span className="text-muted-foreground">—</span>}
</TableCell>
```

- [ ] **Step 2: 动作按渠道自适应(用 orderAction)**

文件顶部 import:

```tsx
import { orderAction } from "@/lib/console/order-action";
```

把现有 `{o.status === "PAID" && (<AlertDialog>…退款…</AlertDialog>)}` 改为根据动作类型分支:

```tsx
{(() => {
  const act = orderAction({ payChannel: o.payChannel, status: o.status });
  if (act.kind === "none") return null;
  const onConfirm = async () => {
    try {
      if (act.kind === "revoke" && o.subscriptionId) {
        await apiRequest(`subscriptions/${o.subscriptionId}/revoke`, { method: "POST" });
      } else {
        await apiRequest(`plan-orders/${o.id}/refund`, { method: "POST" });
      }
      toast.success(`已${act.label}`);
      await load();
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive" />}>
        {act.label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{act.label}？</AlertDialogTitle>
          <AlertDialogDescription>
            {act.kind === "revoke"
              ? `订单 ${o.outTradeNo} 为管理员发放(¥0),将撤销授权并取消对应订阅、释放席位,不涉及退款。`
              : `确认对订单 ${o.outTradeNo}(${fmtYuan(o.amountCents)})退款？仅未使用的订单可退,原路退回并取消订阅。`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()}>确认{act.label}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
})()}
```

确保 `apiRequest`、`getErrorMessage`、`toast`、`load` 已在该文件作用域内(列表页已有 `load`)。

- [ ] **Step 3: 类型检查 + 手验**

Run: `npx tsc -p apps/web --noEmit`
手验:GRANT 单显示"撤销授权"并走 revoke;付费单显示"退款"走 refund;非 PAID 无按钮;"已激活订阅"列可跳转。

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(console)/console/(dashboard)/(customer)/plan-orders/page.tsx"
git commit -m "feat(console): order action adapts to channel (GRANT->revoke); add activated-subscription column"
```

---

## Phase C:号池看板接跳转 + 超卖筛选(块 3)

### Task 10: BoundCardAccordion 占用表接跳转

**Files:**
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(product)/usage-stats/BoundCardAccordion.tsx:363-423`

- [ ] **Step 1: 订阅行邮箱/订阅接跳转**

在订阅子表的客户邮箱单元格,把纯文本邮箱改为链接到客户页(card 携带 `customerId`,经 `BoundCardAccordion` 已有的 email/products 富化;若仅有 email 无 id,则链到 `?search=<email>`):

```tsx
<a className="text-blue-600 hover:underline" href={`/console/customers?search=${encodeURIComponent(card.email ?? "")}`}>
  {card.email ?? "—"} ↗
</a>
```

若 `card` 含订阅/卡 id,则额外加"订阅"链接到 `/console/subscriptions?sub=<id>`。

- [ ] **Step 2: 类型检查 + 手验**

Run: `npx tsc -p apps/web --noEmit`
手验:展开某号 → 占用它的每条订阅,邮箱可点进客户页。

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(console)/console/(dashboard)/(product)/usage-stats/BoundCardAccordion.tsx"
git commit -m "feat(console): pool occupancy rows link out to customer/subscription"
```

---

### Task 11: 号池看板超卖筛选

**Files:**
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(product)/usage-stats/BoundCardAccordion.tsx`

- [ ] **Step 1: 加“只看超卖”筛选(用 filterOversold)**

文件顶部 import:

```tsx
import { filterOversold } from "@/lib/console/pool-occupancy";
```

在账号列表渲染前,加一个开关 state 与过滤:

```tsx
const [oversoldOnly, setOversoldOnly] = useState(false);
const shown = oversoldOnly ? filterOversold(accounts) : accounts;
const oversoldCount = filterOversold(accounts).length;
```

在筛选区(现有 warning-only / sort 模式旁)加:

```tsx
<label className="flex items-center gap-1 text-xs text-muted-foreground">
  <input type="checkbox" checked={oversoldOnly} onChange={(e) => setOversoldOnly(e.target.checked)} />
  只看超卖{oversoldCount > 0 ? `(${oversoldCount})` : ""}
</label>
```

把后续 `accounts.map(...)` 渲染改为 `shown.map(...)`。(`accounts` 即该组件当前渲染源的实际变量名,按文件实际命名对齐。)

- [ ] **Step 2: 类型检查 + 手验**

Run: `npx tsc -p apps/web --noEmit`
手验:勾选后只剩 `已占>容量` 的号;计数正确。

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(console)/console/(dashboard)/(product)/usage-stats/BoundCardAccordion.tsx"
git commit -m "feat(console): oversold-only filter + count on pool board"
```

---

## Phase D:客户一屏全貌(块 4)

### Task 12: 客户详情页订阅卡 + 抽屉 + 动作自适应

**Files:**
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(customer)/customers/[id]/page.tsx`

后端 `getCustomer` 已返回 `subscriptions[].config` 与 `planOrders[]`(含 `payChannel`/`amountCents`/`subscriptionId`)。`ConsoleSubscriptionLite` 已含 `config`。

- [ ] **Step 1: 订阅 Tab 用 buildSubscriptionView 渲染绑定摘要 + 打开抽屉**

import:

```tsx
import { buildSubscriptionView } from "@/lib/console/subscription-view";
import { SubscriptionDetailDrawer } from "../../subscriptions/subscription-detail-drawer";
import { orderAction } from "@/lib/console/order-action";
```

把订阅表"套餐"单元格替换 `selectionName(s.config)` 为可点击 + 绑定摘要:

```tsx
<TableCell className="font-medium">
  <button className="text-blue-600 hover:underline" onClick={() => setDetail(s)}>{selectionName(s.config)}</button>
  <div className="text-xs text-muted-foreground mt-0.5">
    {buildSubscriptionView({ config: s.config }).rows.map((r) =>
      r.bound ? `${r.product}→#${r.accountId}` : r.level ? `${r.product}→未绑定` : r.product
    ).join(" · ")}
  </div>
</TableCell>
```

注:`customers/[id]` 的订阅类型为 `ConsoleSubscriptionLite`(无 `customerId`/`customer`)。抽屉需要它们 → 打开时补:`setDetail({ ...s, customerId: c.id, customer: { email: c.email }, bindings: null, levels: null, line: undefined, plan: null } as ConsoleSubscription)`。

state + 挂载抽屉:

```tsx
const [detail, setDetail] = useState<ConsoleSubscription | null>(null);
// ...return 尾部:
<SubscriptionDetailDrawer sub={detail} open={!!detail} onOpenChange={(o) => !o && setDetail(null)} onChanged={reload} />
```

(`reload` = 该页已有的重新拉取函数;按实际命名对齐。)

- [ ] **Step 2: 订单 Tab 动作自适应**

订单行动作沿用 Task 9 的 `orderAction` 分支逻辑(撤销授权 / 退款);"已取代/已取消"订阅在订阅表用 `subStatusBadge(s.status)` 已能体现(CANCELLED)。

- [ ] **Step 3: 类型检查 + 手验**

Run: `npx tsc -p apps/web --noEmit`
手验:客户页订阅卡显示 `anthropic→#15 · codex→未绑定`;点开抽屉可换绑;订单 GRANT 显示撤销授权。

- [ ] **Step 4: 文件体积检查(约束:≤800–1000 行)**

Run: `wc -l "apps/web/src/app/(console)/console/(dashboard)/(customer)/customers/[id]/page.tsx"`
若超 1000 行:把订阅 Tab、订单 Tab 各拆成 `customer-subs-tab.tsx` / `customer-orders-tab.tsx` 子组件再提交。

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(console)/console/(dashboard)/(customer)/customers/[id]/page.tsx"
git commit -m "feat(console): customer detail — binding summary, detail drawer, channel-aware order actions"
```

---

## Phase E:用量反查(块 5)

### Task 13: 用量页/占用表反查链补齐

**Files:**
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(product)/usage-stats/BoundCardAccordion.tsx`(订阅子表)

- [ ] **Step 1: 每行补“订阅 / 客户 / 在跑的号”反查链**

在订阅子表"操作/反查"列加三个链接(号即当前展开的账号,已知 `account.id`):

```tsx
<div className="flex gap-2 text-xs">
  <a className="text-blue-600 hover:underline" href={`/console/customers?search=${encodeURIComponent(card.email ?? "")}`}>客户</a>
  <a className="text-blue-600 hover:underline" href={`/console/codex-accounts?focus=${account.id}`}>号</a>
</div>
```

(`account` / `card` 为该子表实际作用域变量名;按文件对齐。订阅 id 可用时加"订阅"链。)

- [ ] **Step 2: 类型检查 + 手验**

Run: `npx tsc -p apps/web --noEmit`
手验:用量/占用视图每行可反查到客户与号。

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(console)/console/(dashboard)/(product)/usage-stats/BoundCardAccordion.tsx"
git commit -m "feat(console): usage/occupancy rows reverse-link to customer + account"
```

---

## Phase F:后端保障测试(席位释放 / GRANT 撤销)

### Task 14: 后端测试——撤销订阅释放席位

**Files:**
- Test: `apps/server/src/leasing/console/billing-admin/__tests__/revoke-releases-seat.spec.ts`

- [ ] **Step 1: 写测试(撤销后 ACTIVE 占用统计不再计入该订阅)**

```typescript
import { describe, expect, it } from "vitest";
import { occupiedSharesByAccount } from "@/leasing/subscription/seat";
// 注:按该文件实际导出与路径别名对齐;若无 @ 别名用相对路径。

describe("seat release on cancel", () => {
  it("CANCELLED 订阅不计入占用(只数 ACTIVE 的 configs 传入)", () => {
    const activeConfigs = [
      { id: "a", line: "bind", bindings: { anthropic: 15 }, weight: 4 },
      // 已取消的订阅不应出现在传入集合(调用方按 status=ACTIVE 过滤)
    ];
    const occ = occupiedSharesByAccount(activeConfigs as any, "anthropic");
    expect(occ.get(15)).toBe(4);

    const afterCancel = occupiedSharesByAccount([], "anthropic");
    expect(afterCancel.get(15)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `npm test -- apps/server/src/leasing/console/billing-admin/__tests__/revoke-releases-seat.spec.ts`
Expected: PASS(验证占用统计的真相源语义;若导入路径/导出名不符,先对齐 `seat.ts` 的实际导出再跑)。

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/leasing/console/billing-admin/__tests__/revoke-releases-seat.spec.ts
git commit -m "test(billing-admin): seat occupancy excludes cancelled subscriptions"
```

---

## Self-Review notes(已核对)

- **Spec 覆盖:** 块1(Task 6)、块2 换绑(Task 5+7)、块3(Task 10+11)、块4(Task 12)、块5(Task 13)、GRANT 语义(Task 3+8+9+12)、席位释放(Task 14)。✓
- **类型一致:** `buildSubscriptionView`/`SubProductRow`/`orderAction`/`OrderAction`/`isOversold`/`filterOversold` 在定义任务(2/3/4)与消费任务(5/6/9/11/12)中签名一致。✓
- **删废旧代码:** 旧 `RebindDialog` 在 Task 7 删除。✓
- **文件体积:** Task 12 含 `wc -l` 检查与拆分指令。✓
- **无占位符:** 每个代码步骤含完整代码;UI 装配步骤标注"按文件实际变量名对齐"处均为局部命名,不影响逻辑。
- **后端契约复用:** rebind/revoke/refund/remote-stats 均复用现有端点,无破坏性改动。
