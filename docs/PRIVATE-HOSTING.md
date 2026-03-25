# Windows Private Hosting

This document is for customer delivery on a Windows server. The goal is simple:
the customer should only need to double-click the launcher files and open the
site in a browser.

## Delivery Mode

- Web, API, Worker, SQLite, and Redis all run on the customer's own machine
- AdsPower Local API stays on the same Windows host
- The customer does not need to open terminals or run `pnpm dev:*`

## Files To Hand Over

Use these three files from the repo root:

- `Start-GFA.bat`
- `Stop-GFA.bat`
- `Status-GFA.bat`

## Prerequisites

Install these once on the Windows host:

- Node.js LTS
- `pnpm`
- Docker Desktop or another Docker runtime with `docker compose`
- AdsPower desktop app with Local API enabled

## First Start

1. Double-click `Start-GFA.bat`
2. Wait for the launcher to finish the bootstrap steps
3. Open the public portal:
   `http://<server-ip>:3000/`
4. Open the operations console:
   `http://<server-ip>:3000/console/login`

Default seeded console accounts:

- `admin@gfa.local` / `admin123`
- `support@gfa.local` / `admin123`

## What The Launcher Does

On first boot it will automatically:

- create `.env` from `.env.example` if missing
- install dependencies if the workspace has no `node_modules`
- start Redis with Docker
- run `pnpm db:init:sqlite`
- run `pnpm db:seed`
- run `pnpm build` if production artifacts are missing
- launch Web, API, and Worker in background processes

On later boots it will:

- reuse the existing `.env`
- reuse existing build output when available
- restart the managed services in the same order

## Logs And Runtime State

The launcher writes runtime files under:

- `artifacts/private-hosting/logs/`
- `artifacts/private-hosting/state.json`

Typical log files:

- `artifacts/private-hosting/logs/web.out.log`
- `artifacts/private-hosting/logs/api.out.log`
- `artifacts/private-hosting/logs/worker.out.log`

## Environment Notes

Important `.env` entries:

- `WEB_PORT`
- `API_PORT`
- `API_BASE_URL`
- `REDIS_URL`
- `ADSPOWER_HOST`
- `ADSPOWER_API_KEY`

The example file defaults `API_BASE_URL` to `http://127.0.0.1:3001/api`,
which is correct when Web and API run on the same host.

## HTTP vs HTTPS

Console login cookies now follow the actual request scheme by default:

- local/private `http://` works out of the box
- `https://` automatically uses secure cookies

If a reverse proxy hides the original scheme, you can force the behavior with:

```env
CONSOLE_COOKIE_SECURE="true"
```

or

```env
CONSOLE_COOKIE_SECURE="false"
```

## Daily Operations

- Start service: double-click `Start-GFA.bat`
- Stop service: double-click `Stop-GFA.bat`
- Check status: double-click `Status-GFA.bat`
- Read logs: open `artifacts/private-hosting/logs/`
