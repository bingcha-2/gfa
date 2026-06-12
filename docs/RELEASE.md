# GFA Release Runbook — 9.5.0 force-upgrade + subdomain cutover

Ops sequence for the `bcai.lol` subdomain split. **Order matters**: the client
must be force-upgraded BEFORE the server drops legacy routes, or fielded
clients go dark. Canonical surface/host table: [docs/NAMING.md](./NAMING.md).

Target scheme (locked):

| Host | Serves |
|---|---|
| `bcai.lol` (apex) | 官网 marketing + `/updates/*` (client update feed + downloads) |
| `my.bcai.lol` | toC 用户中心 (`/account/*`, root-stripped) |
| `console.bcai.lol` | toB 管理后台 |
| `api.bcai.lol` | machine API, NestJS direct — `/api/app/*`, `/api/epay/*`, `/api/health` |

---

## 1. Publish the 9.5.0 desktop client (force-update wave)

1. Cut the build via the `build-wails.yml` GitHub Actions workflow
   (`AppVersion` source of truth: `apps/app/updater.go` = `9.5.0`).
2. Place artifacts + update `apps/web/public/updates/latest-wails.json`:
   set **both** `version: 9.5.0` and `minVersion: 9.5.0` (minVersion below
   current ⇒ update not skippable → forced).
3. Feed stays on the apex: clients poll `https://bcai.lol/updates/latest-wails.json`
   every 30 min (+10 s after launch). Existing clients auto-force-update.
4. Wait for the fleet to converge before step 3 (server-side lease logs /
   `clientVersion` heartbeats tell you when stragglers are gone).

The 9.5.0 client targets `api.bcai.lol` (lease + auth) and `my.bcai.lol`
(portal links) only — no `bcai.space` fallback. So finish step 2 before
expecting upgraded clients to work.

## 2. Stand up the subdomains (DNS + TLS + Next env + Caddy)

Apex `bcai.lol` is already live; add the three subdomains:

1. DNS A/AAAA for `my.bcai.lol`, `console.bcai.lol`, `api.bcai.lol` → this
   server (plain records preferred so IP allowlists see real client IPs;
   Caddy auto-provisions TLS once DNS resolves).
2. Next.js env, then restart the web process:
   - `MARKETING_HOST=bcai.lol`, `ACCOUNT_HOST=my.bcai.lol`, `CONSOLE_HOST=console.bcai.lol`
   - `ACCOUNT_COOKIE_DOMAIN` / `CONSOLE_COOKIE_DOMAIN` (scope `gfa.user.token` / `gfa.console.token`)
   - `ADMIN_IP_ALLOWLIST` for the console host
3. Apply the new Caddyfile — **run `caddy validate --config <file>` first**,
   then reload. Caddy and the Next env must switch together (either alone
   leaves a surface 404ing).
4. Smoke: `https://api.bcai.lol/api/health`, login at `my.bcai.lol`,
   console reachable only on `console.bcai.lol` (404 elsewhere).

## 3. Deploy the server with legacy removed

Deploy `apps/server` (legacy gone: bare admin aliases, `/remote-*` lease
routes, card-string runtime lease branch; `minClientVersion = 9.5.0` in
`leasing/lease-core/lease-service.ts`).

**After this step only 9.5.0+ account-login clients can lease — that is why
step 1 (force-update wave) must complete first.**

## 4. Post-cutover notes

- **Bind-card still works**: redemption (`findByKey`) was kept — upgraded
  users convert an old card into a subscription at
  `my.bcai.lol/account/billing`. Only the card-string *runtime lease* path
  is gone.
- Update feed + installers stay on the apex (`bcai.lol/updates/*`) — do not
  move them to `api.bcai.lol`.
- Client env overrides for staging/dev: `BCAI_AUTH_BASE`, `BCAI_API_BASE`,
  `BCAI_CODEX_API_BASE`, `BCAI_ANTHROPIC_REMOTE_BASE`, `BCAI_UPDATE_URL`.
- Rollback: re-point DNS/Caddy only; do NOT re-introduce `bcai.space` — the
  9.5.0 client has no second-host fallback.
