# 子计划 C-web：账户中心"我的订阅"页(展示全部 + 排优先级) Implementation Plan

> **For agentic workers:** 前端子计划 —— 验证用 **preview**(preview_start/snapshot/click/screenshot),不是纯 vitest。建议在 context 干净的会话里聚焦执行。

**Goal:** web 账户中心新增"我的订阅"页:展示账户名下**全部订阅**(状态/产品/额度/优先级),用户可 **↑↓ 调整优先级**(= B 的接力顺序)。落地 B 后端接力 + C-后端接口的用户可见界面。

**Architecture:** 后端 `getOverview` 的 subscription 补 `priority` 字段(前端排序需要)→ 前端 `user-types` 加 priority、`user-api` 加 `setSubscriptionPriority`(调 C-B2 的 `POST /account/subscriptions/priority`)→ 新页面 `/account/subscriptions` + client 组件 `SubscriptionsPanel`(列表 + ↑↓)→ `AccountTopNav` 加菜单 + i18n 文案。

**Tech Stack:** Next.js(App Router)+ React client component + 现有 `account-*` CSS + sonner toast + lucide 图标。

> 前置(已完成):C-B2 已提供 `POST /api/account/subscriptions/priority`(body `{subscriptionId, priority}` → `{ok, subscriptions}`);`getPortalOverview()` 已返回 `subscriptions[]`+quota。

---

## File Structure

| 文件 | 改动 |
|---|---|
| `apps/server/src/leasing/account/portal/portal.service.ts` | `getOverview` 的 subscription select+map 加 `priority` |
| `apps/server/src/leasing/account/portal/__tests__/portal.service.spec.ts` | overview 含 priority 断言 |
| `apps/web/src/lib/account/user-types.ts` | `Subscription` 加 `priority: number` |
| `apps/web/src/lib/account/user-api.ts` | 加 `setSubscriptionPriority` |
| `apps/web/src/components/account/subscriptions-panel.tsx` | **新建** client 组件(列表 + ↑↓ 排序) |
| `apps/web/src/app/(account)/account/(main)/subscriptions/page.tsx` | **新建** 页面 |
| `apps/web/src/components/account/account-topnav.tsx` | `NavKey`+`PRIMARY` 加 subscriptions |
| i18n dict(`portalApp.nav` 定义文件) | 加 `nav.subscriptions` + `pages.subscriptionsTitle` |

---

## Task C-W1: 后端 getOverview 补 priority(单元 TDD)

**Files:** `portal.service.ts`(getOverview ~72-100) + `portal.service.spec.ts`

- [ ] **Step 1: 改测试(红)** —— overview case 断言 `subscriptions[0].priority` 存在(按现有 spec mock 风格,mock 的 subscription rows 加 priority 字段,期望 map 输出含 priority)。
- [ ] **Step 2: 跑** `cd apps/server && pnpm vitest run src/leasing/account/portal -t "overview"` → FAIL。
- [ ] **Step 3: 实现** —— `getOverview` 里查 subscription 的 `select`(~72)加 `priority: true`;`rawSubs.map`(~80-101)输出加 `priority: sub.priority`:
```typescript
      return {
        id: sub.id,
        planName: null,
        status: sub.status as string,
        products: productEntitlements,
        expiresAt: sub.expiresAt ? sub.expiresAt.toISOString() : null,
        deviceLimit: sub.deviceLimit,
        weight: sub.weight,
        priority: sub.priority,
        migratedFromCard: sub.migratedFromKey != null,
        quota,
      };
```
> select 那处确认加了 `priority: true`(否则 `sub.priority` undefined)。
- [ ] **Step 4: 跑** 同上 → PASS;`pnpm lint` EXIT 0。
- [ ] **Step 5: Commit** `git add portal.service.ts portal.service.spec.ts && git commit -m "feat(server): portal getOverview 返回 subscription.priority(前端排序需要)"`(+Co-Authored-By)。

---

## Task C-W2: 前端类型 + API(无独立测试,随 C-W3 验)

**Files:** `user-types.ts` + `user-api.ts`

- [ ] **Step 1:** `user-types.ts` 的 `Subscription` type(81-91)加 `priority: number;`(在 weight 后)。
- [ ] **Step 2:** `user-api.ts` 加(参照 `renameDevice` 的 PATCH/POST 风格):
```typescript
export async function setSubscriptionPriority(subscriptionId: string, priority: number) {
  return userApi<{ ok: true; subscriptions: OverviewSubscription[] }>("subscriptions/priority", {
    method: "POST",
    body: { subscriptionId, priority },
  });
}
```
> `OverviewSubscription` 从 user-types import(文件顶部若没有则补)。
- [ ] **Step 3:** `cd apps/web && pnpm lint`(或 tsc)确认类型通过。Commit。

---

## Task C-W3: 订阅页 + SubscriptionsPanel 组件(preview 验证)

**Files:** 新建 `subscriptions-panel.tsx` + `subscriptions/page.tsx`

- [ ] **Step 1: 新建组件** `apps/web/src/components/account/subscriptions-panel.tsx`(client,参照 `account-overview-panel.tsx` 的取数+渲染风格):
```tsx
"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowUpIcon, ArrowDownIcon } from "lucide-react";
import { getPortalOverview, setSubscriptionPriority } from "@/lib/account/user-api";
import type { OverviewSubscription } from "@/lib/account/user-types";
import { formatTokens } from "@/lib/format";

function statusLabel(s: string) { return s.toUpperCase() === "ACTIVE" ? "有效" : s.toUpperCase() === "EXPIRED" ? "已过期" : s; }
function remainPct(sub: OverviewSubscription): number | null {
  const b = sub.quota?.buckets?.[0];
  if (!b || b.limit <= 0) return null;
  return Math.max(0, 100 - Math.min(100, Math.round((b.used / b.limit) * 100)));
}

export function SubscriptionsPanel() {
  const [subs, setSubs] = useState<OverviewSubscription[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { getPortalOverview().then((o) => setSubs(o.subscriptions)).catch(() => setSubs([])); }, []);

  // 升序展示(priority 小=优先)。
  const ordered = subs ? [...subs].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)) : null;

  async function move(idx: number, dir: -1 | 1) {
    if (!ordered) return;
    const target = ordered[idx + dir];
    const cur = ordered[idx];
    if (!target || !cur || busy) return;
    setBusy(true);
    try {
      // 交换两者 priority:把 cur 设到 target 的位置值。
      const res = await setSubscriptionPriority(cur.id, target.priority ?? (idx + dir));
      await setSubscriptionPriority(target.id, cur.priority ?? idx);
      setSubs(res.subscriptions);
      toast.success("优先级已更新");
    } catch { toast.error("更新失败,请重试"); }
    finally { setBusy(false); }
  }

  if (!ordered) return <div className="account-page__loading">加载中…</div>;
  if (ordered.length === 0) return <div className="account-empty">还没有订阅。<a href="/account/billing">去购买套餐 →</a></div>;

  return (
    <div className="account-subs" data-testid="subscriptions-panel">
      <p className="account-subs__hint">订阅按优先级从上到下使用;当前订阅某产品额度用尽时,自动接力到下一个。用 ↑↓ 调整顺序。</p>
      <ul className="account-subs__list">
        {ordered.map((sub, i) => {
          const pct = remainPct(sub);
          return (
            <li key={sub.id} className="account-subs__item" data-status={sub.status.toUpperCase()}>
              <div className="account-subs__rank">{i + 1}</div>
              <div className="account-subs__main">
                <div className="account-subs__row">
                  <span className="account-subs__products">{sub.products.join(" · ") || "—"}</span>
                  <span className="account-subs__status" data-ok={sub.status.toUpperCase() === "ACTIVE" || undefined}>{statusLabel(sub.status)}</span>
                </div>
                <div className="account-subs__meta">
                  <span>到期 {sub.expiresAt ? sub.expiresAt.slice(0, 10) : "∞"}</span>
                  <span>余量 {pct === null ? "—" : `${pct}%`}</span>
                  <span>本期 {sub.quota ? formatTokens(sub.quota.recentWindowTokens) : "—"}</span>
                </div>
              </div>
              <div className="account-subs__moves">
                <button type="button" aria-label="上移" disabled={i === 0 || busy} onClick={() => move(i, -1)}><ArrowUpIcon className="size-4" /></button>
                <button type="button" aria-label="下移" disabled={i === ordered.length - 1 || busy} onClick={() => move(i, 1)}><ArrowDownIcon className="size-4" /></button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: 新建页面** `apps/web/src/app/(account)/account/(main)/subscriptions/page.tsx`(参照 usage/page.tsx):
```tsx
import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/account/page-header";
import { SubscriptionsPanel } from "@/components/account/subscriptions-panel";

export const dynamic = "force-dynamic";

export default async function SubscriptionsPage() {
  const dict = await getDict();
  return (
    <div className="account-page">
      <PageHeader title={dict.portalApp.pages.subscriptionsTitle ?? "我的订阅"} />
      <SubscriptionsPanel />
    </div>
  );
}
```

- [ ] **Step 3: 加最小 CSS**(在 `account.css` 末尾,参照现有 account-* 风格加 `.account-subs*` 几条;列表项 flex、rank 徽标、↑↓ 按钮)。可先用最小可用样式,preview 后微调。

- [ ] **Step 4: preview 验证**
  1. `preview_start`(apps/web dev server)。
  2. 登录态访问 `/account/subscriptions`(若需登录,用现有测试账户或 preview_fill 登录)。
  3. `preview_snapshot` 确认订阅列表渲染(rank/products/status/余量/↑↓)。
  4. `preview_click` 点"下移",`preview_snapshot` 确认顺序变 + toast"优先级已更新"。
  5. `preview_screenshot` 留证。
  6. `preview_console_logs` 确认无报错。

- [ ] **Step 5: Commit** `git add subscriptions-panel.tsx subscriptions/page.tsx account.css && git commit -m "feat(web): 账户中心'我的订阅'页 — 展示全部订阅 + ↑↓ 排优先级"`。

---

## Task C-W4: 菜单 + i18n(preview 验证)

**Files:** `account-topnav.tsx` + i18n dict 文件

- [ ] **Step 1:** `account-topnav.tsx`:`NavKey`(26-35)加 `| "subscriptions"`;`PRIMARY`(40-46)在 usage 后插:
```typescript
  { id: "subscriptions", url: "/account/subscriptions", icon: <LayersIcon className="size-4" /> },
```
(从 lucide 引入 `LayersIcon`)。
- [ ] **Step 2:** 找 i18n dict 定义(`grep -rn "portalApp" apps/web/src/lib/i18n` 或 messages 目录,找 `nav: { overview, billing, devices, usage, ... }` 和 `pages: {...}`),给**每个语言**加 `nav.subscriptions`("我的订阅"/"Subscriptions"…)和 `pages.subscriptionsTitle`。
- [ ] **Step 3: preview 验证** —— reload,确认顶部导航出现"我的订阅"、点击进入页面、active 高亮正确。`preview_screenshot`。
- [ ] **Step 4: Commit** `git add account-topnav.tsx <dict 文件> && git commit -m "feat(web): 账户导航加'我的订阅'入口 + i18n"`。

---

## 验收(C-web 完成定义)
- `/account/subscriptions` 展示账户全部订阅(按 priority),每项有状态/产品/到期/余量 + ↑↓ 调序。
- ↑↓ 调序调用 `POST /account/subscriptions/priority`,列表实时重排 + toast 反馈。
- 顶部导航有"我的订阅"入口。
- preview 截图证明渲染 + 交互无报错;`pnpm lint`(web + server)通过。
- **不含**:拖拽排序(↑↓ 已够)、app 客户端(C-app 子计划,Wails 需本地构建验证)。

## Self-Review
- 覆盖 spec §4.4 的 web 部分。后端依赖(getOverview 补 priority)作为 C-W1 显式列出。
- 占位符:i18n dict 文件位置用 grep 指引(真实存在);CSS"最小可用 + preview 微调"是前端正常迭代。
- 类型一致:`Subscription.priority`(user-types)↔ getOverview 输出 ↔ SubscriptionsPanel 消费一致;`setSubscriptionPriority` 返回 `{ok, subscriptions}` ↔ C-B2 后端一致。
