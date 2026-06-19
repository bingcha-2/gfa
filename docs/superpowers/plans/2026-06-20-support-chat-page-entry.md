# Support Chat Page Entry Implementation Plan

> **For BingchaAI Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user has already approved implementation, so execute inline in this session.

**Goal:** Add a dedicated AI customer service page at `/account/support`, make login return to it safely, and add the approved bright support entry to the Wails client guide page.

**Design Source:** `docs/superpowers/specs/2026-06-20-support-chat-page-entry-design.md`

**Approved Visual Option:** A. A compact, bright strip below the guide subtitle and above search.

## Constraints

- Reuse existing account support APIs:
  - `GET /api/account/support/conversation`
  - `POST /api/account/support/chat`
- Keep the existing account floating support widget.
- The standalone support page must not blank out when the support agent is disabled. It should show a useful unavailable state.
- The client guide entry opens `https://my.bcai.lol/account/support`.
- Unauthenticated `/account/support` redirects to `/account/login?next=/account/support`.
- Login must only honor safe internal `/account...` next targets.
- Do not revert unrelated dirty files in the working tree.

## Step 1: Add Tests First

Create focused tests that fail before implementation.

### 1.1 Safe login next helper

Add `apps/web/src/test/account/safe-account-next.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { safeAccountNext } from "@/lib/account/safe-account-next";

describe("safeAccountNext", () => {
  it("keeps internal account paths", () => {
    expect(safeAccountNext("/account/support")).toBe("/account/support");
    expect(safeAccountNext("/account?tab=billing")).toBe("/account?tab=billing");
  });

  it("rejects unsafe or non-account targets", () => {
    expect(safeAccountNext(null)).toBe("/account");
    expect(safeAccountNext("https://evil.example/account/support")).toBe("/account");
    expect(safeAccountNext("//evil.example/account/support")).toBe("/account");
    expect(safeAccountNext("/console/support-insights")).toBe("/account");
  });
});
```

### 1.2 Login form redirect

Add or extend a login form test to mock `next/navigation`, submit the form, and confirm:

```ts
useSearchParams().get("next") === "/account/support"
router.push("/account/support")
```

Also confirm unsafe values push `/account`.

### 1.3 Standalone support page surface

Add `apps/web/src/test/account/support-chat-page.test.tsx` rendering the new page component with mocked account provider and mocked user API:

```ts
vi.mock("@/lib/account/user-api", () => ({
  getSupportConversation: vi.fn(),
  sendSupportMessage: vi.fn(),
}));
```

Cover:

- Page renders the customer-service title and input.
- A disabled/unavailable conversation result renders a useful unavailable state with links/actions for FAQ and tickets.
- Existing floating widget can keep using the shared chat surface.

### 1.4 Wails guide entry

Add `apps/app/frontend/src/pages/FaqPage.test.tsx`:

```ts
vi.mock("@/services/wails", () => ({
  api: {
    openURL: vi.fn(),
    PORTAL_URLS: {
      home: "https://my.bcai.lol/account",
      support: "https://my.bcai.lol/account/support",
    },
  },
}));
```

Cover:

- The guide renders `在线客服`.
- Clicking `立即咨询` calls `api.openURL(api.PORTAL_URLS.support)`.

## Step 2: Implement Safe Login Next

Add `apps/web/src/lib/account/safe-account-next.ts`:

```ts
export function safeAccountNext(value: string | null | undefined): string {
  if (!value || value.startsWith("//")) return "/account";

  try {
    const parsed = new URL(value, "https://my.bcai.lol");
    if (parsed.origin !== "https://my.bcai.lol") return "/account";
    if (!parsed.pathname.startsWith("/account")) return "/account";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/account";
  }
}
```

Update `apps/web/src/components/account/auth/login-form.tsx`:

- Import `useSearchParams`.
- Import `safeAccountNext`.
- After successful login, push `safeAccountNext(searchParams.get("next"))` instead of always `/account`.

## Step 3: Add `/account/support`

Create `apps/web/src/app/(account)/account/support/page.tsx`.

Implementation shape:

```tsx
import { redirect } from "next/navigation";
import { AccountShell } from "@/components/account/account-shell";
import { SupportChatPage } from "@/components/account/support-chat-page";
import { serverUserApi } from "@/lib/account/user-server-api";
import type { Customer } from "@/lib/account/user-types";

export const dynamic = "force-dynamic";

export default async function AccountSupportPage() {
  let customer: Customer;
  try {
    ({ customer } = await serverUserApi<{ customer: Customer }>("me"));
  } catch {
    redirect("/account/login?next=/account/support");
  }

  return (
    <AccountShell initialCustomer={customer}>
      <SupportChatPage />
    </AccountShell>
  );
}
```

## Step 4: Reuse Chat Logic For Full Page

Refactor `apps/web/src/components/account/support-chat-widget.tsx` so the conversation mechanics live in a shared exported component:

```tsx
export function SupportChatSurface({ mode }: { mode: "widget" | "page" }) {
  // existing getSupportConversation/sendSupportMessage logic
}
```

Keep `SupportChatWidget` as the floating launcher and render `SupportChatSurface mode="widget"` inside the panel.

Add `apps/web/src/components/account/support-chat-page.tsx`:

```tsx
import { SupportChatSurface } from "./support-chat-widget";

export function SupportChatPage() {
  return (
    <section className="support-page">
      <div className="support-page__header">
        <span className="support-page__eyebrow">AI 客服</span>
        <h1>在线客服</h1>
        <p>遇到额度、登录、订阅或客户端问题，可以在这里直接和 AI 助手聊。</p>
      </div>
      <SupportChatSurface mode="page" />
    </section>
  );
}
```

Add page-specific CSS to the existing support stylesheet or account stylesheet:

- No nested card-in-card layout.
- Chat page has stable panel height and readable empty/error states.
- Input and CTA have focus states.

## Step 5: Add Client Guide Entry

Update `apps/app/frontend/src/services/wails.ts`:

```ts
export const PORTAL_URLS = {
  ...,
  support: `${PORTAL_BASE}/account/support`,
};
```

Update `apps/app/frontend/src/pages/FaqPage.tsx`:

- Render approved A banner below the subtitle and above search.
- Use `MessageCircle` or existing support icon.
- `onClick={() => api.openURL(api.PORTAL_URLS.support)}`.

Add locale keys to existing Wails locale files if the page uses i18n:

- `faq.supportTitle`
- `faq.supportDesc`
- `faq.supportCta`

## Step 6: Verify

Run targeted tests first:

```powershell
pnpm --filter @gfa/web test -- src/test/account/safe-account-next.test.ts src/test/account/support-chat-page.test.tsx
pnpm --dir apps/app/frontend test -- src/pages/FaqPage.test.tsx
```

Then run broader checks if targeted tests pass:

```powershell
pnpm --filter @gfa/web lint
pnpm --dir apps/app/frontend build
```

If a command is unavailable or too broad for the current environment, record the exact failure and run the closest meaningful focused check.

## Step 7: Review Git Scope

Before committing:

```powershell
git status --short
git diff -- docs/superpowers/plans/2026-06-20-support-chat-page-entry.md apps/web apps/app/frontend
```

Stage only files related to this feature. Do not stage unrelated quota/client files unless they were intentionally touched for this task.
