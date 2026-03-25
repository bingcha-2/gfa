/**
 * Worker test helpers.
 *
 * Provides a shared PrismaClient pointing at the dev SQLite DB,
 * cleanup utilities, and mock factories for BullMQ Job objects.
 */
import { PrismaClient } from "@prisma/client";
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

export async function createTestAccount(overrides: Partial<{
  name: string;
  loginEmail: string;
  adspowerProfileId: string;
  loginPassword: string;
  totpSecret: string;
}> = {}) {
  const db = getPrisma();
  const ts = Date.now();
  return db.account.create({
    data: {
      name: overrides.name ?? `Account-${ts}`,
      loginEmail: overrides.loginEmail ?? `acct-${ts}@gmail.com`,
      adspowerProfileId: overrides.adspowerProfileId ?? `profile-${ts}`,
      loginPassword: overrides.loginPassword,
      totpSecret: overrides.totpSecret,
    }
  });
}

export async function createTestFamilyGroup(
  accountId: string,
  overrides: Partial<{
    groupName: string;
    maxMembers: number;
    availableSlots: number;
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
      status: (overrides.status as any) ?? "ACTIVE",
    }
  });
}

export async function createTestTask(
  type: string,
  overrides: Partial<{
    orderId: string;
    familyGroupId: string;
    accountId: string;
    payload: string;
    status: string;
  }> = {}
) {
  const db = getPrisma();
  return db.task.create({
    data: {
      type: type as any,
      orderId: overrides.orderId,
      familyGroupId: overrides.familyGroupId,
      accountId: overrides.accountId,
      payload: overrides.payload ?? "{}",
      status: (overrides.status as any) ?? "PENDING",
    }
  });
}

export async function createTestOrder(
  overrides: Partial<{
    orderNo: string;
    userEmail: string;
    familyGroupId: string;
    redeemCodeId: string;
    status: string;
  }> = {}
) {
  const db = getPrisma();
  const ts = Date.now();
  return db.order.create({
    data: {
      orderNo: overrides.orderNo ?? `GFA-TEST-${ts}`,
      userEmail: overrides.userEmail ?? `user-${ts}@gmail.com`,
      familyGroupId: overrides.familyGroupId,
      redeemCodeId: overrides.redeemCodeId,
      status: (overrides.status as any) ?? "TASK_QUEUED",
    }
  });
}

/**
 * Create a mock BullMQ Job object for testing processors.
 */
export function createMockJob<T>(data: T, overrides: Partial<{
  id: string;
  name: string;
  attemptsMade: number;
}> = {}): any {
  return {
    id: overrides.id ?? `test-job-${Date.now()}`,
    name: overrides.name ?? "test-job",
    data,
    attemptsMade: overrides.attemptsMade ?? 0,
    updateProgress: async () => {},
    log: async () => {},
  };
}
