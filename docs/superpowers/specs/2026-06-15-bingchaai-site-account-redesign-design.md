# BingchaAI Website And Account Redesign Design

Date: 2026-06-15

## Summary

Redesign the full BingchaAI marketing site and account portal with a system-level brand upgrade.

The direction is **preserve and upgrade**: keep the existing BingchaAI identity, amber accent, deep indigo dark mode, logo assets, member-pass signature element, route structure, API contracts, and multilingual content model. Replace the current repeated marketing-page rhythm and account-page hierarchy with a sharper, more intentional system.

Design read: existing SaaS marketing site plus authenticated account portal for users buying and managing AI tool access, with a premium but practical software-operations language. The implementation should lean on the existing Next.js, Tailwind v4, shadcn-style component base, CSS tokens, and current account data APIs.

## Scope

### In Scope

- Marketing pages:
  - `/`
  - `/features`
  - `/how-it-works`
  - `/quickstart`
  - `/download`
  - `/faq`
  - `/about` remains a redirect to `/`
- Account pages:
  - Auth: `/account/login`, `/account/register`, `/account/forgot`, `/account/reset`, `/account/verify-email`
  - Main: `/account`, `/account/billing`, `/account/billing/plans`, `/account/subscriptions`, `/account/usage`, `/account/tickets`, `/account/notifications`, `/account/download`, `/account/me`
  - Compatibility redirects remain for `/account/devices`, `/account/settings`, `/account/referral`
- Shared marketing shell, nav, footer, page primitives, and marketing CSS.
- Shared account shell, navigation, account design tokens, account overview, and page-level layout primitives.
- Existing loading, empty, error, and disabled states on account workflows.
- Mobile and desktop responsive behavior.
- Light and dark modes for both marketing and account surfaces.

### Out Of Scope

- Changing API endpoints or server contracts.
- Changing route slugs or SEO-critical URLs.
- Replacing the BingchaAI logo or brand name.
- Rewriting all dictionary copy from scratch.
- Adding new product features.
- Rebuilding deprecated apps under `_deprecated/`.
- Creating a standalone `/about` page while it currently redirects.

## Preserve

- Current product positioning: BingchaAI as a managed access layer for AI tools.
- Existing brand assets:
  - `/bcai-icon.png`
  - `/product-shots/client-preview-beautified.png`
  - `/logos/antigravity.svg`
  - `/logos/codex.svg`
  - `/logos/claude.svg`
- Existing marketing route structure and metadata generation.
- Existing account authentication guard and `serverUserApi("me")` flow.
- Existing account client APIs from `user-api.ts`.
- Existing i18n dictionary structure.
- Existing release metadata fetch from `/updates/latest-wails.json`.
- Existing support settings fetch from `/console/faq/settings`.

## Visual System

### Brand Language

Use the current amber and deep-indigo foundation, but tighten it:

- Dark-first marketing hero and key sections, with a light mode that feels equally designed.
- Amber remains the single primary accent.
- Deep indigo and charcoal carry premium software depth.
- Product color accents for Antigravity, Codex, and Claude stay secondary and contextual.
- Avoid generic AI-purple glow, generic glass panels, equal three-card rows, repeated eyebrows, and fake product UI drawn from divs.

### Typography

- Keep the existing `next/font` stack.
- Use strong sans display typography, not a default serif.
- Headlines should be compact, high-contrast, and max two lines in hero contexts.
- Account pages use tighter text scale and tabular numeric treatment for quota, usage, order, and device data.

### Shape And Layout

- Use a consistent radius scale:
  - Small controls: 8-10px.
  - Product/account panels: 16-22px.
  - Member pass: 22-24px.
- Use cards only when they clarify real hierarchy.
- Prefer section rhythm, real screenshots, split compositions, timeline layouts, data strips, and grouped panels over repeated card grids.

### Icons And Assets

- Current code uses `lucide-react`; keep it for account because the dependency already exists and the app is already built around it.
- Marketing pages should reduce hand-rolled SVG icons. Prefer existing logo assets, product screenshots, and the current icon dependency where icons are needed.
- Do not create fake product screenshots out of div rectangles. Use the existing client screenshot or real UI components.

## Marketing Site Design

### Shared Marketing Shell

Update `MarketingShell`, `MarketingNav`, `MarketingFooter`, and `marketing.css` around a new set of page primitives:

- `MarketingHero`
- `MarketingPageHeader`
- `ProductShotFrame`
- `FeatureBand`
- `ProcessTimeline`
- `SupportPanel`
- `DownloadMatrix`
- `CTASection`

Navigation should stay one line on desktop. Keep language and theme controls. The primary CTA remains download-oriented, with account as the secondary CTA.

### Homepage `/`

Purpose: conversion and product understanding.

Structure:

1. Asymmetric hero:
   - Left: concise value proposition and two CTAs.
   - Right: real client screenshot plus a smaller member/account visual.
   - No trust strip inside the hero.
2. Product support band:
   - Antigravity, Codex, Claude as logo-backed tiles, not identical text cards.
3. How it works preview:
   - A short process layout that links to `/how-it-works`.
4. Capability section:
   - Group capabilities by operational job, not by equal card count.
5. Trust and safety section:
   - Explain local proxy, official endpoints, and account handling with a structured visual.
6. Account portal section:
   - Use the member-pass motif and account actions.
7. Final CTA:
   - One download CTA and one account CTA.

### Features `/features`

Purpose: show what the product can do.

Structure:

- Hero with the real product screenshot.
- Capability clusters:
  - Client control.
  - Quota visibility.
  - Tool takeover.
  - Settings and operational safeguards.
- Replace generic feature cards with mixed layout:
  - Product screenshot.
  - Grouped rows.
  - Accent panels.
  - Short copy.

### How It Works `/how-it-works`

Purpose: explain the architecture and reduce trust concerns.

Structure:

- Architecture overview with a clear flow:
  - User tools.
  - Local client.
  - BingchaAI access layer.
  - Official AI endpoints.
- Request lifecycle as timeline, not generic numbered cards.
- Account-pool rotation and quota model as grouped panels.
- Safety model with explicit boundaries.

### Quickstart `/quickstart`

Purpose: get a user from zero to working.

Structure:

- Step-by-step task checklist:
  - Download.
  - Buy or activate access.
  - Enable takeover.
  - Verify usage.
- Card-key explanation as a compact support block.
- Link to download and account flows at the exact decision points.

### Download `/download`

Purpose: choose the right build quickly.

Structure:

- OS-detected recommended download first.
- Secondary platform cards below.
- Version, size, and hash information retained, but visually subordinate.
- Changelog rendered as a compact release note.
- Installation guide below download matrix.

### FAQ `/faq`

Purpose: resolve support questions quickly.

Structure:

- Search remains prominent.
- Contact panel appears before or beside FAQ list when settings exist.
- FAQ categories collapse cleanly.
- Empty and no-result states remain explicit.

### About `/about`

Keep the redirect to `/`. Do not create a thin placeholder page.

## Account Portal Design

### Account Shell

Move desktop navigation from horizontal top tabs to a left rail plus top action area.

Desktop:

- Left rail:
  - Overview.
  - Billing.
  - Usage.
  - Support.
  - Downloads.
  - Me.
- Top action area:
  - Notifications.
  - Locale.
  - Theme.
  - User menu.

Mobile:

- Keep drawer navigation.
- Keep account actions compact.
- Preserve route behavior.

The shell must keep the server guard and `AccountProvider` structure.

### Account Overview `/account`

Purpose: answer "can I use the service right now?"

Structure:

- Hero/status block:
  - Current membership state.
  - Direct renewal or purchase action.
  - Download action.
- Member pass:
  - Preserve as signature visual, but reduce decorative dominance.
  - Keep state, plan, member ID, and expiry.
- Operational stats:
  - Quota left.
  - Device count.
  - Recent usage.
  - Account status.
- Quick actions:
  - Subscriptions.
  - Billing.
  - Notifications.
  - Download.
  - Tickets.
- Warning banner remains for expired or expiring plans.
- Load error remains visible without blocking account entry.

### Billing `/account/billing`

Purpose: manage subscriptions and order history.

Structure:

- Keep subscription and order data flows.
- Separate active subscription summary from order history.
- Make purchase or renew path visually primary.
- Keep cancel, sync, and refund actions in contextual row actions.
- Error state should explain that subscription/order data could not refresh.

### Plans `/account/billing/plans`

Purpose: choose and buy a plan.

Structure:

- Keep catalog loading states.
- Plan selector stays functional.
- Price preview should feel like a checkout summary, not a marketing card.
- Maintain unavailable and error states.

### Subscriptions `/account/subscriptions`

Purpose: inspect entitlement and quota relay.

Structure:

- Keep relay ordering controls.
- Group subscription details into entitlement, quota, expiry, and products.
- Use compact status chips and meters.

### Usage `/account/usage`

Purpose: understand recent model usage.

Structure:

- Keep current charts and tables.
- Add clearer top summary strip.
- Preserve date/model filters.
- Ensure empty and loading states are visually aligned with account panels.

### Tickets `/account/tickets`

Purpose: contact support and inspect support history.

Structure:

- Contact card at top when WeChat or QR settings exist.
- Ticket list below.
- Preserve ticket status and urgent badges.
- Thread page keeps conversation layout.

### Notifications `/account/notifications`

Purpose: review system and account messages.

Structure:

- Keep unread indicators.
- Group actions and timestamps more tightly.
- Empty state should point users back to overview.

### Download `/account/download`

Purpose: provide account-context client download.

Structure:

- Match marketing download visually but more compact.
- Keep release fetch and hash visibility.
- Add account-specific install note if copy exists.

### Me `/account/me`

Purpose: manage devices and security.

Structure:

- Preserve existing tabs for devices and security.
- Make tab state and destructive actions clearer.
- Keep redirects from `/account/devices` and `/account/settings`.

### Auth Pages

Purpose: authenticate without feeling detached from the brand.

Structure:

- Keep current auth flows and form validation.
- Align `AuthCard` visual language with marketing and account tokens.
- Maintain field labels above inputs, helper/error text below inputs, and accessible focus rings.

## Data Flow

No data contracts change.

Marketing:

- Dictionaries come from `getDict()` or `useDict()`.
- FAQ data comes from `/console/faq`.
- FAQ contact settings come from `/console/faq/settings`.
- Download release metadata comes from `/updates/latest-wails.json`.

Account:

- Server guard fetches `me` before rendering protected pages.
- `AccountProvider` continues to hold customer, logout, and unread state.
- Overview loads `getPortalOverview()`.
- Billing loads `getSubscriptions()`, `listBillingOrders()`, order sync/cancel/refund APIs.
- Plans load `getPlanCatalog()`.
- Other account pages keep their existing API hooks.

## Error Handling And States

Marketing:

- FAQ fetch failure returns an empty FAQ list but still shows support context if available.
- Download metadata failure falls back to a usable latest download state.
- All CTA labels must remain readable in both themes.

Account:

- Existing skeletons remain, but match the new layout geometry.
- Load errors are shown inline, not as full-page failures unless authentication fails.
- Empty states use account-panel styling and a direct next action.
- Disabled and busy actions keep clear visual feedback.
- Mobile drawer state closes on route change.

## Accessibility

- Preserve semantic links and buttons.
- Labels stay above inputs.
- No placeholder-as-label.
- Keyboard focus rings must remain visible.
- CTAs must have sufficient contrast in light and dark modes.
- Desktop nav stays one line where applicable; account rail collapses on mobile.
- Reduced motion must disable nonessential transitions.
- No content should rely on color alone for state.

## Motion

Use restrained motion:

- Marketing:
  - Light section reveals and hover states.
  - No scroll hijack for this pass.
  - No marquee.
- Account:
  - Subtle hover, active, loading, and panel transition feedback.
  - Avoid decorative animation in dense workflows.

Motion dial:

- Marketing: `DESIGN_VARIANCE 7`, `MOTION_INTENSITY 4`, `VISUAL_DENSITY 4`.
- Account: `DESIGN_VARIANCE 5`, `MOTION_INTENSITY 3`, `VISUAL_DENSITY 7`.

## Testing Plan

### Unit And Component Tests

Add or update focused tests where behavior changes:

- Account top navigation:
  - active state.
  - mobile drawer close on route change.
  - notification badge.
- Account overview:
  - loading state.
  - load error state.
  - expiring and expired warning states.
  - quick action links.
- Marketing download:
  - platform detection fallback.
  - release metadata fallback.
- FAQ:
  - search empty state.
  - category collapse behavior.

### Visual And Runtime Verification

Run:

- `pnpm --filter @gfa/web test`
- `pnpm --filter @gfa/web lint`
- `pnpm --filter @gfa/web build`

Then verify in browser:

- Marketing home.
- Features.
- How it works.
- Quickstart.
- Download.
- FAQ.
- Account overview.
- Billing.
- Usage.
- Tickets.
- Me.
- Login.
- Mobile viewport around 390px.
- Desktop viewport around 1280px.
- Light and dark theme states.

## Implementation Notes

- Prefer refactoring shared marketing/account primitives before rewriting pages.
- Keep edits scoped to `apps/web/src/app`, `apps/web/src/components/marketing`, `apps/web/src/components/account`, and related tests.
- Do not touch server API behavior.
- Do not change route names.
- Do not introduce new design-system packages unless existing dependencies cannot cover the needed UI.
- Keep `lucide-react` in account because it is already a dependency and existing account components use it.
- Replace marketing hand-rolled SVG usage where practical with existing assets or the current icon dependency.

## Acceptance Criteria

- Marketing pages no longer read as repeated template sections.
- Account desktop shell uses a left rail and top action area.
- Account mobile remains usable with drawer navigation.
- Homepage hero uses real product imagery and fits the first viewport.
- Download page prioritizes the detected OS while retaining alternate downloads and hash information.
- FAQ search and support contact remain functional.
- Account overview answers membership status, quota, devices, usage, and next action in one view.
- All existing protected-route behavior still works.
- Existing redirects remain intact.
- Tests and build pass.
