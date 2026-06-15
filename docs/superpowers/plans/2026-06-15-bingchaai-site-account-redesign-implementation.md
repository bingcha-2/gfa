# BingchaAI Site Account Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved BingchaAI marketing site and account portal redesign while preserving routes, data APIs, auth flow, and i18n contracts.

**Architecture:** Build shared primitives first, then migrate marketing pages and account surfaces onto them. Marketing and account use the same brand tokens but different density: marketing is open and narrative, account is compact and operational.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind v4 CSS, existing shadcn-style components, existing `lucide-react`, Vitest and Testing Library.

---

## Reference Spec

- `docs/superpowers/specs/2026-06-15-bingchaai-site-account-redesign-design.md`

## Parallel Work Slices

Workers may run in parallel only when their write sets do not overlap:

- Marketing worker owns `apps/web/src/components/marketing/**`, `apps/web/src/app/(marketing)/**`, and marketing-specific tests.
- Account shell worker owns `apps/web/src/components/account/account-shell.tsx`, `account-topnav.tsx`, `account-theme.tsx`, `account.css` shell/nav sections, and topnav tests.
- Account overview worker owns `account-overview-panel.tsx`, overview-specific CSS, and overview tests.
- Account workflow worker owns account workflow page components such as billing, subscriptions, usage, tickets, notifications, download, me, auth card styling, and related tests.
- Integration worker owns final CSS cleanup, duplicate class removal, build fixes, browser QA, and final verification.

Do not edit files outside your assigned write set unless the controller explicitly hands that file to you.

## Files And Responsibilities

- `apps/web/src/components/marketing/marketing.css`: marketing tokens, layout primitives, responsive behavior, dark/light themes.
- `apps/web/src/components/marketing/nav.tsx`: one-line desktop nav, mobile menu, account/download CTAs.
- `apps/web/src/components/marketing/footer.tsx`: final brand footer and route links.
- `apps/web/src/app/(marketing)/page.tsx`: homepage narrative.
- `apps/web/src/app/(marketing)/features/page.tsx`: capability page.
- `apps/web/src/app/(marketing)/how-it-works/page.tsx`: architecture and lifecycle page.
- `apps/web/src/app/(marketing)/quickstart/page.tsx`: setup checklist page.
- `apps/web/src/app/(marketing)/download/page.tsx`: OS-aware download page.
- `apps/web/src/app/(marketing)/faq/page.tsx`: FAQ route and support entry.
- `apps/web/src/components/marketing/faq-list.tsx`: FAQ search, category collapse, contact panel.
- `apps/web/src/components/account/account-shell.tsx`: account app frame.
- `apps/web/src/components/account/account-topnav.tsx`: desktop rail and mobile drawer navigation.
- `apps/web/src/components/account/account-overview-panel.tsx`: account overview operating panel.
- `apps/web/src/components/account/account.css`: account tokens, shell, nav, overview, workflow panels.
- `apps/web/src/components/account/account-billing-center.tsx`: billing layout if needed.
- `apps/web/src/components/account/subscriptions-panel.tsx`: subscription relay layout if needed.
- `apps/web/src/components/account/usage-view.tsx`, `usage-table.tsx`, `usage-charts.tsx`: usage page hierarchy.
- `apps/web/src/components/account/tickets-list.tsx`, `ticket-contact.tsx`, `ticket-thread.tsx`: support center hierarchy.
- `apps/web/src/components/account/notifications-list.tsx`: message center hierarchy.
- `apps/web/src/components/account/account-me.tsx`: devices/security hub.
- `apps/web/src/components/account/auth/auth-card.tsx`: branded auth card.
- `apps/web/src/test/account/*.test.tsx`: focused behavior and design contract tests.

## Task 1: Marketing Shared System

**Files:**
- Modify: `apps/web/src/components/marketing/marketing.css`
- Modify: `apps/web/src/components/marketing/nav.tsx`
- Modify: `apps/web/src/components/marketing/footer.tsx`
- Optional create: `apps/web/src/test/marketing/marketing-shell.test.tsx`

- [ ] **Step 1: Write failing tests for the marketing shell contracts**

Create `apps/web/src/test/marketing/marketing-shell.test.tsx` with:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { MarketingFooter } from "@/components/marketing/footer";
import { MarketingNav } from "@/components/marketing/nav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/features",
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/lib/i18n/client", () => ({
  useDict: () => ({
    common: {
      brandName: "冰茶AI",
      downloadClient: "下载客户端",
      userCenter: "用户中心",
    },
    nav: {
      features: "功能",
      howItWorks: "工作原理",
      quickstart: "快速开始",
      faq: "常见问题",
      mainNav: "主导航",
      menu: "菜单",
      toggleTheme: "切换主题",
    },
    footer: {
      desc: "一个可控入口连接常用 AI 工具。",
      product: "产品",
      download: "下载",
      features: "功能",
      quickstart: "快速开始",
      howItWorks: "工作原理",
      help: "帮助",
      faq: "常见问题",
      account: "用户中心",
      api: "API",
      terminal: "终端",
      copyright: "Copyright",
      tagline: "BingchaAI",
    },
  }),
  useLocale: () => "zh-CN",
  setLocaleCookie: vi.fn(),
}));

describe("marketing shell redesign contracts", () => {
  it("keeps the marketing nav compact and marks active route", () => {
    render(<MarketingNav />);

    expect(document.querySelector(".mkt-nav")).toBeInTheDocument();
    expect(document.querySelector(".mkt-nav__links")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "功能" })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("link", { name: /下载客户端/ })).toHaveAttribute("href", "/download");
  });

  it("renders a branded footer with product and help route groups", () => {
    render(<MarketingFooter />);

    expect(screen.getByRole("link", { name: /冰茶AI/ })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "下载" })).toHaveAttribute("href", "/download");
    expect(screen.getByRole("link", { name: "用户中心" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gfa/web test -- src/test/marketing/marketing-shell.test.tsx`

Expected: FAIL if the new test directory or expected shell contracts are not implemented yet.

- [ ] **Step 3: Implement the shared marketing shell**

Update:

- `nav.tsx` so desktop nav remains one line, primary action is `/download`, secondary action is account, language/theme controls remain.
- `footer.tsx` so footer uses compact product/help groups and brand summary.
- `marketing.css` so new primitives exist:
  - `.mkt-shell-grid`
  - `.mkt-hero-media`
  - `.mkt-feature-band`
  - `.mkt-process`
  - `.mkt-support-panel`
  - `.mkt-download-matrix`
  - `.mkt-final-cta`

Keep existing class names that current pages still use until page migration is complete.

- [ ] **Step 4: Run focused test**

Run: `pnpm --filter @gfa/web test -- src/test/marketing/marketing-shell.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/marketing apps/web/src/test/marketing/marketing-shell.test.tsx
git commit -m "feat(web): refresh marketing shell system"
```

## Task 2: Marketing Pages

**Files:**
- Modify: `apps/web/src/app/(marketing)/page.tsx`
- Modify: `apps/web/src/app/(marketing)/features/page.tsx`
- Modify: `apps/web/src/app/(marketing)/how-it-works/page.tsx`
- Modify: `apps/web/src/app/(marketing)/quickstart/page.tsx`
- Modify: `apps/web/src/app/(marketing)/download/page.tsx`
- Modify: `apps/web/src/app/(marketing)/faq/page.tsx`
- Modify: `apps/web/src/components/marketing/faq-list.tsx`
- Test: `apps/web/src/test/marketing/marketing-pages.test.tsx`

- [ ] **Step 1: Write failing tests for page contracts**

Create `apps/web/src/test/marketing/marketing-pages.test.tsx` with static source checks:

```tsx
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("marketing page redesign source contracts", () => {
  it("homepage uses real product imagery and avoids the old hero trust strip", () => {
    const source = read("app/(marketing)/page.tsx");

    expect(source).toContain("/product-shots/client-preview-beautified.png");
    expect(source).not.toContain("mkt-hero__trust");
    expect(source).not.toContain("<ClientMock");
  });

  it("marketing pages use the new mixed-layout primitives", () => {
    const files = [
      "app/(marketing)/features/page.tsx",
      "app/(marketing)/how-it-works/page.tsx",
      "app/(marketing)/quickstart/page.tsx",
      "app/(marketing)/download/page.tsx",
      "app/(marketing)/faq/page.tsx",
    ];

    const combined = files.map(read).join("\n");
    expect(combined).toContain("mkt-feature-band");
    expect(combined).toContain("mkt-process");
    expect(combined).toContain("mkt-download-matrix");
    expect(combined).toContain("mkt-support-panel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gfa/web test -- src/test/marketing/marketing-pages.test.tsx`

Expected: FAIL because pages still use the old section rhythm.

- [ ] **Step 3: Migrate pages**

Implement:

- Homepage asymmetric hero with real screenshot, product logo band, process preview, grouped capabilities, trust/safety visual, account portal section, final CTA.
- Features page with screenshot-led hero and mixed capability bands.
- How-it-works page with architecture/process layout.
- Quickstart page with task checklist and card-key support panel.
- Download page with OS-detected recommended card and compact metadata.
- FAQ page with support panel and category/search layout.

Do not change route names, metadata functions, or i18n keys unless required by TypeScript.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm --filter @gfa/web test -- src/test/marketing/marketing-pages.test.tsx
pnpm --filter @gfa/web lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/'(marketing)' apps/web/src/components/marketing apps/web/src/test/marketing/marketing-pages.test.tsx
git commit -m "feat(web): redesign marketing pages"
```

## Task 3: Account Shell And Navigation

**Files:**
- Modify: `apps/web/src/components/account/account-shell.tsx`
- Modify: `apps/web/src/components/account/account-topnav.tsx`
- Modify: `apps/web/src/components/account/account.css`
- Test: `apps/web/src/test/account/account-topnav.test.tsx`

- [ ] **Step 1: Update failing topnav tests first**

Modify `account-topnav.test.tsx` to assert the new rail:

```tsx
it("renders a desktop account rail and keeps billing active", () => {
  render(<AccountTopNav />);

  const rail = document.querySelector(".account-rail");
  expect(rail).toBeInTheDocument();
  const billingLink = screen.getByRole("link", { name: /订阅|Billing/i });
  expect(billingLink).toHaveAttribute("data-active");
  expect(billingLink).toHaveClass("account-rail__link");
});

it("keeps account actions in the top action bar", () => {
  render(<AccountTopNav />);

  expect(document.querySelector(".account-actionbar")).toBeInTheDocument();
  expect(screen.getByLabelText(/通知|Notifications/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /菜单|Menu/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gfa/web test -- src/test/account/account-topnav.test.tsx`

Expected: FAIL because `.account-rail` and `.account-actionbar` do not exist yet.

- [ ] **Step 3: Implement account shell**

Update:

- `AccountShell` to render app frame classes needed for rail + main content.
- `AccountTopNav` to provide desktop rail navigation and top action bar.
- Mobile menu remains available and closes on route change.
- Keep `AccountLocaleSwitcher`, `AccountThemeToggle`, notifications link, user menu, and logout.

- [ ] **Step 4: Add CSS for shell**

In `account.css`, add:

- `.account-app` grid shell.
- `.account-rail`
- `.account-rail__brand`
- `.account-rail__nav`
- `.account-rail__link`
- `.account-actionbar`
- `.account-main`
- mobile media queries that collapse rail and use drawer.

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --filter @gfa/web test -- src/test/account/account-topnav.test.tsx
pnpm --filter @gfa/web lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/account/account-shell.tsx apps/web/src/components/account/account-topnav.tsx apps/web/src/components/account/account.css apps/web/src/test/account/account-topnav.test.tsx
git commit -m "feat(web): add account rail shell"
```

## Task 4: Account Overview

**Files:**
- Modify: `apps/web/src/components/account/account-overview-panel.tsx`
- Modify: `apps/web/src/components/account/account.css`
- Test: `apps/web/src/test/account/account-overview-panel.test.tsx`

- [ ] **Step 1: Add failing overview contract tests**

Extend `account-overview-panel.test.tsx` with:

```tsx
it("groups operational status into the redesigned overview layout", () => {
  render(
    <AccountOverviewPanel
      customerId="cus_1"
      overview={overview}
      loading={false}
      loadError={false}
    />
  );

  const panel = screen.getByTestId("account-overview-panel");
  expect(panel.querySelector(".account-overview-status")).toBeInTheDocument();
  expect(panel.querySelector(".account-overview-actions")).toBeInTheDocument();
  expect(panel.querySelector(".account-overview-statstrip")).toBeInTheDocument();
  expect(panel.querySelector(".account-pass")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gfa/web test -- src/test/account/account-overview-panel.test.tsx`

Expected: FAIL because the new class contracts do not exist yet.

- [ ] **Step 3: Implement overview**

Update `account-overview-panel.tsx`:

- Keep `deriveMembershipStatus` and current membership logic.
- Keep warning banner and load error behavior.
- Render status/action block, member pass, stat strip, and quick actions.
- Keep all existing links and labels.

- [ ] **Step 4: Add CSS**

In overview section of `account.css`, add or update:

- `.account-overview-status`
- `.account-overview-actions`
- `.account-overview-statstrip`
- `.account-pass`
- `.account-quick-card`
- responsive single-column collapse.

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --filter @gfa/web test -- src/test/account/account-overview-panel.test.tsx
pnpm --filter @gfa/web lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/account/account-overview-panel.tsx apps/web/src/components/account/account.css apps/web/src/test/account/account-overview-panel.test.tsx
git commit -m "feat(web): redesign account overview"
```

## Task 5: Account Workflow Pages

**Files:**
- Modify: `apps/web/src/components/account/account-billing-center.tsx`
- Modify: `apps/web/src/components/account/subscriptions-panel.tsx`
- Modify: `apps/web/src/components/account/usage-view.tsx`
- Modify: `apps/web/src/components/account/usage-table.tsx`
- Modify: `apps/web/src/components/account/tickets-list.tsx`
- Modify: `apps/web/src/components/account/ticket-contact.tsx`
- Modify: `apps/web/src/components/account/notifications-list.tsx`
- Modify: `apps/web/src/components/account/account-me.tsx`
- Modify: `apps/web/src/components/account/auth/auth-card.tsx`
- Modify: `apps/web/src/components/account/account.css`
- Test: `apps/web/src/test/account/account-content-design.test.tsx`
- Test: `apps/web/src/test/account/auth-card.test.tsx`

- [ ] **Step 1: Add failing workflow contract tests**

Extend `account-content-design.test.tsx`:

```tsx
it("workflow pages use the redesigned account panel primitives", async () => {
  const css = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL("../../components/account/account.css", import.meta.url),
      "utf8"
    )
  );

  expect(css).toContain(".account-workflow-grid");
  expect(css).toContain(".account-summary-strip");
  expect(css).toContain(".account-support-panel");
});
```

Extend `auth-card.test.tsx` to assert the branded auth surface:

```tsx
it("uses the account auth brand surface", () => {
  const { container } = render(
    <AuthCard title="登录" description="进入用户中心">
      <p>form</p>
    </AuthCard>
  );

  expect(container.querySelector(".account-auth-card")).toBeInTheDocument();
  expect(container.querySelector(".account-auth-card__brand")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @gfa/web test -- src/test/account/account-content-design.test.tsx src/test/account/auth-card.test.tsx
```

Expected: FAIL because new primitives are not present yet.

- [ ] **Step 3: Implement workflow page refinements**

Update workflow components:

- Billing: active subscriptions and order history are visually separated.
- Subscriptions: group entitlement, quota, expiry, products.
- Usage: add top summary strip and align table/chart panels.
- Tickets: support contact panel stays first, ticket list stays below.
- Notifications: message center remains compact with unread state.
- Me: devices/security tab surface is clearer.
- Auth card: align to brand tokens and account visual language.

- [ ] **Step 4: Add CSS primitives**

In `account.css`, add:

- `.account-workflow-grid`
- `.account-summary-strip`
- `.account-support-panel`
- `.account-auth-card`
- `.account-auth-card__brand`

- [ ] **Step 5: Run focused tests and lint**

Run:

```bash
pnpm --filter @gfa/web test -- src/test/account/account-content-design.test.tsx src/test/account/auth-card.test.tsx
pnpm --filter @gfa/web lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/account apps/web/src/test/account/account-content-design.test.tsx apps/web/src/test/account/auth-card.test.tsx
git commit -m "feat(web): refine account workflow pages"
```

## Task 6: Integration, Visual QA, And Final Verification

**Files:**
- Modify only files needed to fix integration issues discovered by tests, build, or browser QA.

- [ ] **Step 1: Run full web verification**

Run:

```bash
pnpm --filter @gfa/web test
pnpm --filter @gfa/web lint
pnpm --filter @gfa/web build
```

Expected: all pass.

- [ ] **Step 2: Start dev server**

Run: `pnpm --filter @gfa/web dev`

Expected: Next dev server starts on port 3000 unless occupied.

- [ ] **Step 3: Browser QA desktop**

Open and inspect:

- `http://localhost:3000/`
- `http://localhost:3000/features`
- `http://localhost:3000/how-it-works`
- `http://localhost:3000/quickstart`
- `http://localhost:3000/download`
- `http://localhost:3000/faq`
- `http://localhost:3000/account/login`

Expected:

- no blank screens.
- nav fits one desktop line.
- hero fits first viewport.
- CTAs have readable contrast.
- no obvious text overlap.

- [ ] **Step 4: Browser QA mobile**

Set viewport near 390px wide and recheck:

- `/`
- `/download`
- `/faq`
- `/account/login`

Expected:

- no horizontal overflow.
- nav uses mobile menu.
- buttons do not wrap awkwardly.
- content remains readable.

- [ ] **Step 5: Pre-flight scan**

Run:

```bash
rg -n $'\\u2014|\\u2013|Quietly|Acme|Jane Doe|John Doe|Elevate|Seamless|Unleash|Next-Gen|Revolutionize' apps/web/src/app/'(marketing)' apps/web/src/components/marketing apps/web/src/components/account || true
rg -n "mkt-hero__trust|<ClientMock|account-client-sidebar" apps/web/src || true
```

Expected: no unwanted matches from redesigned files.

- [ ] **Step 6: Commit final integration fixes**

```bash
git add apps/web
git commit -m "chore(web): finish redesign integration"
```

If there are no integration fixes after previous task commits, skip this commit.
