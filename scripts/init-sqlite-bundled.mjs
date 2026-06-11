/**
 * init-sqlite-bundled.mjs
 *
 * Bundled-mode equivalent of init-sqlite.mjs.
 * Calls prisma CLI via the bundled node_modules rather than via pnpm,
 * so it works without pnpm installed on the end-user machine.
 *
 * Usage (from build-release.ps1 launcher):
 *   node scripts/init-sqlite-bundled.mjs
 *
 * Environment vars:
 *   DATABASE_URL   - absolute SQLite path, e.g. file:C:/Program Files/GFA/data/gfa.db
 *   PRISMA_CLI     - path to the local prisma CLI (bundled apps/server/node_modules/.bin/prisma)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[db:init] DATABASE_URL is not set");
  process.exit(1);
}

// Resolve prisma CLI: try bundled api node_modules first, then PATH
const bundledPrisma = join(rootDir, "apps", "server", "node_modules", ".bin", "prisma");
const prismaCli = existsSync(bundledPrisma + ".cmd")
  ? bundledPrisma + ".cmd"
  : existsSync(bundledPrisma)
  ? bundledPrisma
  : "prisma";

const nodeExe = process.execPath;
const schemaPath = join(rootDir, "prisma", "schema.prisma");

/** Run prisma CLI via node directly (no pnpm needed). */
const runPrisma = (args, extraEnv = {}) => {
  // First try as a cmd/script, fallback to node + module resolution
  const isCmdFile = prismaCli.endsWith(".cmd");

  /** @type {import('node:child_process').SpawnSyncReturns<string>} */
  let result;

  if (isCmdFile || existsSync(prismaCli)) {
    result = spawnSync(prismaCli, args, {
      cwd: rootDir,
      env: { ...process.env, DATABASE_URL: databaseUrl, ...extraEnv },
      encoding: "utf8",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } else {
    // Fallback: call prisma via its JS entry point
    const prismaJs = join(rootDir, "apps", "server", "node_modules", "prisma", "build", "index.js");
    result = spawnSync(nodeExe, [prismaJs, ...args], {
      cwd: rootDir,
      env: { ...process.env, DATABASE_URL: databaseUrl, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  if (result.status !== 0) {
    const msg = [
      `[db:init] prisma ${args[0]} failed (code ${result.status})`,
      result.stdout?.trim(),
      result.stderr?.trim()
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(msg);
  }

  return (result.stdout ?? "").trim();
};

// ── Resolve SQLite file path ──────────────────────────────────────────────────
const resolveSqlitePath = (url) => {
  if (!url.startsWith("file:")) throw new Error(`Unsupported DATABASE_URL: ${url}`);
  const raw = url.replace(/^file:/, "");
  if (!raw) throw new Error("DATABASE_URL has no file path.");
  // Already absolute
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith("/")) return raw;
  // Relative: resolve against prisma/ directory
  return resolve(rootDir, "prisma", raw);
};

const dbPath = resolveSqlitePath(databaseUrl);
const dbDirectory = dirname(dbPath);
mkdirSync(dbDirectory, { recursive: true });

// ── Generate diff SQL ─────────────────────────────────────────────────────────
const isReset = process.argv.includes("--reset");
if (isReset) {
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

const hadExistingDb = existsSync(dbPath);
const diffArgs = hadExistingDb && !isReset
  ? ["migrate", "diff", "--from-url", databaseUrl, "--to-schema-datamodel", schemaPath, "--script"]
  : ["migrate", "diff", "--from-empty", "--to-schema-datamodel", schemaPath, "--script"];

const sql = runPrisma(diffArgs);
const isEmpty =
  !sql ||
  sql.startsWith("-- This is an empty migration.");

if (isEmpty) {
  console.log(`[db:init] schema already in sync: ${dbPath}`);
  process.exit(0);
}

const tempSql = join(tmpdir(), `gfa-init-${Date.now()}.sql`);
writeFileSync(tempSql, sql, "utf8");

try {
  runPrisma(["db", "execute", "--file", tempSql, "--schema", schemaPath]);
  console.log(
    hadExistingDb && !isReset
      ? `[db:init] applied schema changes to ${dbPath}`
      : `[db:init] initialized database at ${dbPath}`
  );
} finally {
  rmSync(tempSql, { force: true });
}
