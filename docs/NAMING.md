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

## Subdomain Plan (DECIDED — implemented in code; env-gated for deploy)

Single primary domain **`bcai.lol`**; each audience gets its own subdomain. No `bcai.space` fallback (force-upgrade model). Browser surfaces serve their API **same-origin** (httpOnly cookie → Bearer via the Next.js proxy); only the cookie-less machine API gets a dedicated host (NestJS direct).

| Subdomain | Audience | Serves | Pages | Same-origin API | Cookie (Domain-scoped) |
|---|---|---|---|---|---|
| `bcai.lol` (apex, `www`→301) | Visitor · 官网 marketing | Next `(marketing)` | `/`, `/about`, `/features`, `/how-it-works`, `/quickstart`, `/faq`, `/download`; `/updates/*` (client update feed) | `/api/faq-images/*` | none |
| `my.bcai.lol` | toC end user · 用户中心 | Next `(account)` | `/account/*` (`/account/billing`, `/account/devices`, …) | `/api/account/*`, `/api/account-session/*` | `gfa.user.token` (Domain=`my.bcai.lol`) |
| `console.bcai.lol` | toB admin · 管理后台 | Next `(console)` | `/console/*`, `/login` | `/api/console/*`, `/api/console-session/*` | `gfa.console.token` (Domain=`console.bcai.lol`) |
| `api.bcai.lol` | machine · desktop client / payment | NestJS direct (:3001) | — | `/api/app/*`, `/api/epay/*`, `/api/health`, `/api/remote-stats/*` | none (Bearer / MD5) |

**Method A (path prefix kept):** the `/account` · `/console` prefix stays in the URL (`my.bcai.lol/account/billing`, `console.bcai.lol/console/groups`) — standard SaaS practice (`app.example.com/dashboard/…`), zero routing risk, and the subdomain already makes the audience unambiguous. Code keeps the `account` / `console` naming end-to-end (route groups, `lib/`, components, cookies, API). Root-strip (method B) was considered and rejected: in a single multi-surface Next app, prefix-less URLs would require per-Host page routing + prefix-aware links + subdomain-based dev — high cost, low benefit.

**Deploy env (Next.js):** `MARKETING_HOST`/`ACCOUNT_HOST`/`CONSOLE_HOST` drive `middleware.ts` Host isolation (all unset = single-domain dev, unchanged); `ACCOUNT_COOKIE_DOMAIN`/`CONSOLE_COOKIE_DOMAIN` scope the cookies; `ADMIN_IP_ALLOWLIST` optional. `api.bcai.lol` is Caddy→NestJS direct (Next never sees it). See `Caddyfile.migration` (4 site blocks) and `docs/RELEASE.md` (cutover order).

### Naming normalization — DONE
- **(a)** Admin frontend calls `/api/console/*`; legacy bare aliases (`/rosetta`, `/accounts`, …) and `/remote-*` routes removed.
- **(b)** `/api/web/*` → `/api/account/*` (server dir `leasing/web/` → `leasing/account/`, module/guard renamed).
- **(c)** `/api/session/*` → `/api/console-session/*`, `/api/web-session/*` → `/api/account-session/*`.

### Force-upgrade (no legacy compatibility) — DONE
No old clients to support. Removed: `/remote-*` lease routes, the card-string **runtime lease** branch in `access-key-store` (bind-card redemption via `findByKey` **retained** — how upgraded users convert an old card into a subscription), the client `bcai.space` fallback and vestigial `/api/activate` call. `minClientVersion` + `latest-wails.json` `minVersion` = `9.5.0`. **Deploy order (see RELEASE.md): publish the 9.5.0 client first → fleet auto-updates → then deploy the server with legacy removed.** (`latest-wails.json` `version` still 9.4.0 — bump to 9.5.0 when the real build is published.)
