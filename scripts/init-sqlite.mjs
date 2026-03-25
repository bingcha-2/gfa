import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const schemaPath = "prisma/schema.prisma";
const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const isReset = process.argv.includes("--reset");
const pnpmCommand = "pnpm";

const run = (args, options = {}) => {
  const result = spawnSync(pnpmCommand, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl
    },
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${pnpmCommand} ${args.join(" ")}`,
        result.stdout?.trim(),
        result.stderr?.trim()
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return result.stdout;
};

const resolveSqlitePath = (url) => {
  if (!url.startsWith("file:")) {
    throw new Error(`Unsupported DATABASE_URL for SQLite init: ${url}`);
  }

  const rawPath = url.replace(/^file:/, "");

  if (!rawPath) {
    throw new Error("DATABASE_URL must include a SQLite file path.");
  }

  if (/^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("/")) {
    return rawPath;
  }

  return resolve(rootDir, "prisma", rawPath);
};

const dbPath = resolveSqlitePath(databaseUrl);
const dbDirectory = dirname(dbPath);
const tempSqlPath = join(tmpdir(), `gfa-sqlite-init-${Date.now()}.sql`);
const hadExistingDb = existsSync(dbPath);
const databaseUrlForDiff = (() => {
  const relativePath = relative(rootDir, dbPath).replace(/\\/g, "/");
  return relativePath.startsWith(".") ? `file:${relativePath}` : `file:./${relativePath}`;
})();

mkdirSync(dbDirectory, { recursive: true });

if (isReset) {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-journal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

const diffArgs = existsSync(dbPath)
  ? [
      "prisma",
      "migrate",
      "diff",
      "--from-url",
      databaseUrlForDiff,
      "--to-schema-datamodel",
      schemaPath,
      "--script"
    ]
  : [
      "prisma",
      "migrate",
      "diff",
      "--from-empty",
      "--to-schema-datamodel",
      schemaPath,
      "--script"
    ];

const sql = run(diffArgs).trim();
const isEmptyMigration =
  !sql ||
  sql === "-- This is an empty migration." ||
  sql === "-- This is an empty migration.\r" ||
  sql.startsWith("-- This is an empty migration.");

if (isEmptyMigration) {
  console.log(`[db:init:sqlite] schema already in sync for ${dbPath}`);
  process.exit(0);
}

writeFileSync(tempSqlPath, sql, "utf8");

try {
  run(["prisma", "db", "execute", "--file", tempSqlPath, "--schema", schemaPath]);
  console.log(
    hadExistingDb && !isReset
      ? `[db:init:sqlite] applied schema changes to ${dbPath}`
      : `[db:init:sqlite] initialized database at ${dbPath}`
  );
} finally {
  rmSync(tempSqlPath, { force: true });
}
