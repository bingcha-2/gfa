# GFA Naming Reference

**Rule: 见名知意零歧义** — every name must be self-explanatory with zero ambiguity.
When two things could share a name, the more specific one wins; generic terms are banned at top level.

---

## Monorepo Apps

| Directory | Product name | Stack | Description |
|-----------|-------------|-------|-------------|
| `apps/server` | **server** | NestJS · Prisma · BullMQ | Business API + token leasing backend (was `apps/api`) |
| `apps/web` | **web** | Next.js · React | Marketing site + toC account centre + toB admin console |
| `apps/app` | **app** | Go · Wails · WebView | 冰茶AI desktop client (was `apps/bcai-wails`; Go module name `bcai-wails` unchanged) |
| `apps/worker` | **worker** | Playwright · AdsPower | Browser automation worker |
| `packages/shared` | **shared** | TypeScript | Shared enums, types, constants |

---

## Backend Business Domains (`apps/server/src/`)

| Directory | Domain | Responsibility |
|-----------|--------|----------------|
| `leasing/` | 号池租赁 + 账号体系 | token-server, lease-core, remote-anthropic, remote-codex, remote-access, remote-stats, rosetta, subscription, plan; also `web/`, `app/`, `console/` HTTP layers |
| `google-family/` | Google Family 自动化 | account, family-group, redeem-code, order, task, expire-scan, automation, scheduler, phone-pool, bulk-2fa, stats/queue controllers |
| `shared/` | 公共基础设施 | prisma, auth (incl. console-jwt.guard), audit-log, common, mail, faq, health |

---

## HTTP API Surfaces (NestJS global prefix `/api`)

| URL prefix | Audience | Notes |
|-----------|----------|-------|
| `/api/web/*` | toC 用户中心 | Customer-facing API |
| `/api/console/*` | toB 管理后台 | Admin/operator API |
| `/api/app/*` | 桌面客户端 | Desktop client API |
| `/api/health` | — | Health check |
| `/api/session/*` | console login proxy | Session handling for console |
| `/api/web-session/*` | customer session | Session handling for web customers |

**Legacy aliases (remove in M13):**

| Legacy path | Current canonical path |
|-------------|----------------------|
| `/auth/*` | → `/api/console/*` |
| `/rosetta/*` | → `/api/console/*` |
| `/accounts/*` | → `/api/console/*` |
| `/family-groups/*` | → `/api/console/*` |
| `/remote-token/*` | → `/api/app/*` |
| `/remote-codex/*` | → `/api/app/*` |
| `/remote-anthropic/*` | → `/api/app/*` |

---

## Web Route Groups (`apps/web/src/app/`)

| Route prefix | Group name | Audience | Description |
|-------------|-----------|---------|-------------|
| `/` `/about` `/features` `/how-it-works` `/quickstart` `/faq` `/download` | **(marketing)** | Public | 官网 marketing pages |
| `/account/*` | **(account)** | toC 用户 | 用户中心 (login, register, billing, devices, …) |
| `/console/*` | **(console)** | toB 管理员 | 管理后台 (orders, rosetta, usage-stats, …) |

> **Why "account" not "app"?** The desktop client already owns the name "app" (`apps/app`, `/api/app`). The toC web area is named "account" to eliminate the ambiguity.

---

## Cookies

| Cookie name | Holder | Purpose |
|-------------|--------|---------|
| `gfa.console.token` | Admin browser | Authenticates toB console sessions |
| `gfa.user.token` | Customer browser | Authenticates toC account sessions |

---

## Desktop Client

| Item | Value |
|------|-------|
| Monorepo path | `apps/app` |
| Go module name | `bcai-wails` (internal; unchanged from rename) |
| AppVersion | `9.5.0` (source of truth: `apps/app/updater.go`) |
| Update manifest | `apps/web/public/updates/latest-wails.json` served at `/updates/latest-wails.json` |
| Client update URL | `https://bcai.lol/updates/latest-wails.json` |
| `minClientVersion` floor | `apps/server/src/leasing/lease-core/lease-service.ts` |

---

## Residual Normalization Flags (decide later)

These inconsistencies are known; they are **not** blocking but should be resolved in a future milestone:

**(a) Console frontend uses legacy bare API paths** — The admin console frontend (`apps/web/src/app/console/`) still calls bare legacy paths (`/rosetta`, `/accounts`, etc.) instead of `/api/console/*`. Plan: migrate frontend calls to `/api/console/*`, then drop the bare aliases. Target: M13.

**(b) API surface vs. page route asymmetry** — The toC API surface is `/api/web/*` while the toC page group is `/account/*`. For perfect symmetry these should both be `account`; renaming `/api/web/*` → `/api/account/*` has caller churn (desktop client, web frontend). Decide whether to rename before M13 freezes the API.

**(c) Session route naming** — `/api/session/*` (console login proxy) vs. `/api/web-session/*` (customer session). Consider renaming `/api/session/*` → `/api/console-session/*` for symmetry with `web-session`. Low-urgency; decide alongside (b).
