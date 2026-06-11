/**
 * seed-bundled.mjs
 *
 * Bundled-mode equivalent of seed.mjs.
 * Imports @prisma/client from the bundled apps/server/node_modules path,
 * without requiring pnpm to be installed on the end-user machine.
 *
 * Environment vars:
 *   DATABASE_URL  - absolute SQLite path
 */

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

// Resolve @prisma/client from the bundled api node_modules
const apiNodeModules = join(rootDir, "apps", "server", "node_modules");
const require = createRequire(import.meta.url);

let PrismaClient;
try {
  // Try bundled path first (bundled mode)
  const prismaClientPath = join(apiNodeModules, "@prisma", "client");
  ({ PrismaClient } = require(prismaClientPath));
} catch {
  // Fallback to ambient resolution (dev mode)
  ({ PrismaClient } = await import("@prisma/client"));
}

const defaultDatabaseUrl = "file:./dev.db";
const rawUrl = process.env.DATABASE_URL ?? defaultDatabaseUrl;

// Resolve relative file: URLs to absolute paths
const resolveDatabaseUrl = (url) => {
  if (!url.startsWith("file:")) return url;
  const rawPath = url.slice("file:".length);
  if (!rawPath || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("/")) return url;
  const absolutePath = resolve(rootDir, "prisma", rawPath).replace(/\\/g, "/");
  return `file:${absolutePath}`;
};

const datasourceUrl = resolveDatabaseUrl(rawUrl);

const prisma = new PrismaClient({ datasourceUrl });

// Fixed bcrypt hash for password: admin123
const HASH = "$2b$10$GTFPOI5Go/p7IFCJa4Njwe/4gidArRwkXGrdCwLR6k6H1VNjHivXa";

const DEFAULT_USERS = [
  { email: "admin@gfa.local",   displayName: "Admin",   role: "ADMIN" },
  { email: "support@gfa.local", displayName: "Support", role: "SUPPORT" }
];

async function seed() {
  try {
    for (const user of DEFAULT_USERS) {
      const existing = await prisma.user.findUnique({ where: { email: user.email } });
      if (existing) {
        console.log(`[seed] user already exists: ${user.email}`);
        continue;
      }
      await prisma.user.create({
        data: { email: user.email, passwordHash: HASH, displayName: user.displayName, role: user.role }
      });
      console.log(`[seed] user created: ${user.email} / admin123`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

seed().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
