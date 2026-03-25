# Google Family Automation

Monorepo for the Google One family automation project.

## Apps

- `apps/web`
  - Internal console and public redeem/status pages
- `apps/api`
  - Business API, queue orchestration, and persistence layer
- `apps/worker`
  - AdsPower + Playwright automation worker
- `packages/shared`
  - Shared enums, queue names, and task types

## Stack

- Next.js
- NestJS
- SQLite
- Prisma
- Redis
- BullMQ
- AdsPower
- Playwright

## Quick Start

1. Copy `.env.example` to `.env`
2. Start infrastructure:

   ```powershell
   docker compose up -d
   ```

   SQLite uses a local Prisma database file, so only Redis is started by Docker.

3. Install dependencies:

   ```powershell
   pnpm install
   ```

4. Generate Prisma client:

   ```powershell
   pnpm db:generate
   ```

5. Initialize the SQLite database:

   ```powershell
   pnpm db:init:sqlite
   ```

   This will create the SQLite file under `prisma/dev.db` on first run and apply
   incremental schema changes on later runs.

   Keep `DATABASE_URL` aligned with Prisma's schema-relative SQLite path:

   ```powershell
   DATABASE_URL="file:./dev.db"
   ```

   `pnpm db:push` and `pnpm db:migrate` are both mapped to the same safe SQLite
   sync flow.

   If you need to recreate the local database from scratch:

   ```powershell
   pnpm db:reset:sqlite
   ```

   This command is destructive and will remove the existing SQLite file.

6. Start apps:

   ```powershell
   pnpm dev:web
   pnpm dev:api
   pnpm dev:worker
   ```

7. Debug queue routes are disabled by default. Only enable them in local
   development by setting:

   ```powershell
   ENABLE_DEBUG_QUEUE_ROUTES=true
   ```

## Windows Private Hosting

For customer delivery on a Windows server, use the bundled launchers from the
repo root instead of manual `pnpm dev:*` commands:

- `Start-GFA.bat`
- `Stop-GFA.bat`
- `Status-GFA.bat`

The first start will:

- copy `.env.example` to `.env` when missing
- install dependencies when `node_modules` is absent
- start Redis with Docker
- initialize and seed SQLite
- build `shared`, `web`, `api`, and `worker`
- launch the three production services in the background

Detailed handoff notes live in `docs/PRIVATE-HOSTING.md`.
