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

## Subdomain Plan (DECIDED — under rollout)

Single primary domain **`bcai.lol`**; each audience gets its own subdomain. No `bcai.space` fallback (force-upgrade model, see below). Browser surfaces serve their API **same-origin** (httpOnly cookie → Bearer via the Next.js proxy); only the cookie-less machine API gets a dedicated host.

| Subdomain | Audience | Serves | Pages (method B: root-stripped) | Same-origin API | Cookie (Domain-scoped) |
|---|---|---|---|---|---|
| `bcai.lol` (apex, `www`→301) | Visitor · 官网 marketing | Next `(marketing)` | `/`, `/about`, `/features`, `/how-it-works`, `/quickstart`, `/faq`, `/download` | — | none |
| `my.bcai.lol` | toC end user · 用户中心 | Next `(account)` | `/billing`, `/devices`, `/usage`, `/notifications`, `/tickets`, `/referral`, `/settings`, `/login`, … | `/api/account/*`, `/api/account-session/*` | `gfa.user.token` |
| `console.bcai.lol` | toB admin · 管理后台 | Next `(console)` | `/groups`, `/orders`, `/codes`, `/rosetta-keys`, … | `/api/console/*`, `/api/console-session/*` | `gfa.console.token` |
| `api.bcai.lol` | machine · desktop client / payment | NestJS direct (:3001) | — | `/api/app/*`, `/api/epay/*` | none (Bearer / MD5) |

**Method B (root-strip):** on `my.`/`console.` the `/account` · `/console` path prefix is internally rewritten away (reusing the `ADMIN_PATH_PREFIX` mechanism), so users see `my.bcai.lol/billing` not `/account/billing`. Internal code keeps the `account` / `console` naming everywhere (route groups, `lib/`, components, cookies) — domain stays friendly, code stays unambiguous. In local dev (no subdomain) the prefixed paths `localhost:3000/account`, `/console` still work.

### Naming normalization being applied during rollout
- **(a) Admin frontend → `/api/console/*`** — drop the legacy bare aliases (`/rosetta`, `/accounts`, …) entirely (no migration period).
- **(b) `/api/web/*` → `/api/account/*`** — full symmetry with the `account` surface; server dir `leasing/web/` → `leasing/account/` too.
- **(c) `/api/session/*` → `/api/console-session/*`**, `/api/web-session/*` → `/api/account-session/*`.

### Force-upgrade (no legacy compatibility)
There are **no old clients to support** — clients are force-upgraded. Therefore, during rollout: remove `/remote-*` legacy lease routes, remove the card-string **runtime lease** branch in `access-key-store` (bind-card redemption via `findByKey` **stays** — that is how upgraded users convert an old card into a subscription), and raise `minClientVersion` + `latest-wails.json` `minVersion` to `9.5.0`. Deploy order: publish the 9.5.0 client → clients auto-update → then deploy the server with legacy removed.
