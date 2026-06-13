/**
 * Worker test helpers.
 *
 * DATABASE_URL is set by vitest.config.ts → env; never hardcode the path here.
 */
import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | null = null;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — run tests via vitest so the env is configured");
  return url;
}

export function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({ datasourceUrl: requireDatabaseUrl() });
  }
  return prisma;
}

export async function cleanDb() {
  const db = getPrisma();
  await db.taskLog.deleteMany().catch(() => {});
  await db.auditLog.deleteMany().catch(() => {});
  await db.task.deleteMany().catch(() => {});
  await db.swapRecord.deleteMany().catch(() => {});
  await db.order.deleteMany().catch(() => {});
  await db.redeemCode.deleteMany().catch(() => {});
  await db.familyInvite.deleteMany().catch(() => {});
  await db.familyMember.deleteMany().catch(() => {});
  await db.transferBatch.deleteMany().catch(() => {});
  await db.agentAccount.deleteMany().catch(() => {});
  await db.familyGroup.deleteMany().catch(() => {});
  await db.account.deleteMany().catch(() => {});
  await db.user.deleteMany().catch(() => {});
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
  status: string;
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
      status: (overrides.status as any) ?? "HEALTHY",
    }
  });
}

export async function createTestFamilyGroup(
  accountId: string,
  overrides: Partial<{
    groupName: string;
    maxMembers: number;
    availableSlots: number;
    pendingInviteCount: number;
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
      pendingInviteCount: overrides.pendingInviteCount ?? 0,
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
