/**
 * customer-test-db.ts — real-Prisma test helpers for the customer account
 * system (Customer / Device / Subscription / PlanOrder / Notification).
 *
 * DATABASE_URL is set by vitest.config.ts → env (points at prisma/test.db).
 * Never hardcode a fallback path here — fail fast if the env is missing.
 */
import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../../../../..");

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — run tests via vitest so the env is configured");
  return url;
}
const databaseUrl = requireDatabaseUrl();

let prisma: PrismaClient | null = null;
let schemaEnsured = false;

export function getCustomerPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  }
  return prisma;
}

/** Push the Prisma schema into the test db if its tables are missing. */
export async function ensureCustomerSchema(): Promise<void> {
  if (schemaEnsured) return;
  const db = getCustomerPrisma();
  try {
    await db.$queryRawUnsafe(`SELECT id FROM "Subscription" LIMIT 1`);
  } catch {
    const prismaCli = resolve(repoRoot, "node_modules/prisma/build/index.js");
    const schemaPath = resolve(repoRoot, "prisma/schema.prisma");
    execSync(`node "${prismaCli}" db push --skip-generate --schema "${schemaPath}"`, {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "ignore",
    });
  }
  schemaEnsured = true;
}

/** Delete all customer-system rows (FK-safe order). */
export async function cleanCustomerTables(): Promise<void> {
  const db = getCustomerPrisma();
  await db.notification.deleteMany();
  await db.device.deleteMany();
  await db.subscription.deleteMany();
  await db.planOrder.deleteMany();
  await db.customerEmailToken.deleteMany();
  await db.customer.deleteMany();
}

export async function disconnectCustomerDb(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

let seq = 0;

export async function createTestCustomer(overrides: Partial<{
  email: string;
  tokenVersion: number;
  status: "ACTIVE" | "DISABLED";
}> = {}) {
  const db = getCustomerPrisma();
  seq += 1;
  return db.customer.create({
    data: {
      email: overrides.email ?? `cust-${Date.now()}-${seq}@test.local`,
      passwordHash: "$2b$10$test-hash-placeholder",
      status: (overrides.status ?? "ACTIVE") as any,
      tokenVersion: overrides.tokenVersion ?? 0,
      referralCode: `REF${Date.now().toString(36)}${seq}`.toUpperCase(),
    },
  });
}

/** Decode the payload segment of a JWT without verifying (test inspection). */
export function decodeJwtPayload(token: string): any {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}
