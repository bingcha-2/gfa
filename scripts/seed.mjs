import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const defaultDatabaseUrl = "file:./dev.db";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = defaultDatabaseUrl;
}

function resolveDatabaseUrl(rawUrl) {
  if (!rawUrl.startsWith("file:")) {
    return rawUrl;
  }

  const rawPath = rawUrl.slice("file:".length);

  if (!rawPath || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("/")) {
    return rawUrl;
  }

  const absolutePath = resolve(rootDir, "prisma", rawPath).replace(/\\/g, "/");
  return `file:${absolutePath}`;
}

const run = (args) => {
  const result = spawnSync("pnpm", args, {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: pnpm ${args.join(" ")}`);
  }
};

async function seed() {
  // Dynamic import after ensuring prisma client is generated
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({
    datasourceUrl: resolveDatabaseUrl(process.env.DATABASE_URL ?? defaultDatabaseUrl)
  });

  try {
    // Fixed bcrypt hash for password: admin123
    const hash = "$2b$10$GTFPOI5Go/p7IFCJa4Njwe/4gidArRwkXGrdCwLR6k6H1VNjHivXa";
    const defaultUsers = [
      {
        email: "admin@gfa.local",
        displayName: "Admin",
        role: "ADMIN"
      },
      {
        email: "support@gfa.local",
        displayName: "Support",
        role: "SUPPORT"
      }
    ];

    for (const user of defaultUsers) {
      const existing = await prisma.user.findUnique({
        where: { email: user.email }
      });

      if (existing) {
        console.log(`[seed] user already exists: ${user.email}`);
        continue;
      }

      await prisma.user.create({
        data: {
          email: user.email,
          passwordHash: hash,
          displayName: user.displayName,
          role: user.role
        }
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
