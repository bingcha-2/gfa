/**
 * Shared test helpers: creates a real PrismaClient connected to the dev SQLite DB
 * and provides cleanup utilities.
 */
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { resolve } from "node:path";

let prisma: PrismaClient | null = null;
const databaseUrl = `file:${resolve(__dirname, "../../../../prisma/dev.db").replace(/\\/g, "/")}`;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      datasourceUrl: databaseUrl
    });
  }

  return prisma;
}

export async function cleanDb() {
  const db = getPrisma();

  // Delete in correct order for FK constraints
  await db.taskLog.deleteMany();
  await db.auditLog.deleteMany();
  await db.task.deleteMany();
  await db.order.deleteMany();
  await db.redeemCode.deleteMany();
  await db.familyInvite.deleteMany();
  await db.familyMember.deleteMany();
  await db.familyGroup.deleteMany();
  await db.account.deleteMany();
  await db.user.deleteMany();
}

export async function disconnectDb() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

export async function createTestUser(overrides: Partial<{
  email: string;
  password: string;
  role: string;
  displayName: string;
}> = {}) {
  const db = getPrisma();
  const hash = await bcrypt.hash(overrides.password ?? "test123", 10);

  return db.user.create({
    data: {
      email: overrides.email ?? `test-${Date.now()}@gfa.local`,
      passwordHash: hash,
      displayName: overrides.displayName ?? "Test User",
      role: (overrides.role ?? "ADMIN") as any
    }
  });
}

export async function createTestAccount(overrides: Partial<{
  name: string;
  loginEmail: string;
  adspowerProfileId: string;
}> = {}) {
  const db = getPrisma();
  const ts = Date.now();

  return db.account.create({
    data: {
      name: overrides.name ?? `Account-${ts}`,
      loginEmail: overrides.loginEmail ?? `acct-${ts}@gmail.com`,
      adspowerProfileId: overrides.adspowerProfileId ?? `profile-${ts}`
    }
  });
}

export async function createTestFamilyGroup(
  accountId: string,
  overrides: Partial<{
    groupName: string;
    maxMembers: number;
    availableSlots: number;
    riskScore: number;
    status: string;
  }> = {}
) {
  const db = getPrisma();

  return db.familyGroup.create({
    data: {
      accountId,
      groupName: overrides.groupName ?? `Group-${Date.now()}`,
      maxMembers: overrides.maxMembers ?? 6,
      availableSlots: overrides.availableSlots ?? 5,
      riskScore: overrides.riskScore ?? 0,
      status: (overrides.status as any) ?? "ACTIVE"
    }
  });
}

export async function createTestRedeemCode(
  createdById?: string,
  overrides: Partial<{
    code: string;
    status: string;
    expiresAt: Date;
  }> = {}
) {
  const db = getPrisma();

  return db.redeemCode.create({
    data: {
      code: overrides.code ?? `CODE-${Date.now()}`,
      product: "GOOGLE_ONE",
      status: (overrides.status as any) ?? "UNUSED",
      expiresAt: overrides.expiresAt,
      createdById
    }
  });
}
