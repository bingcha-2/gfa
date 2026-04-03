/**
 * Test seed script for Scheduler feature validation.
 * 
 * Creates:
 * - 1 admin user
 * - 5 accounts (3 HEALTHY, 1 RISKY, 1 LOGIN_REQUIRED)
 * - 8 family groups across accounts (some with stale sync)
 * - Various members with different states (ACTIVE, PENDING, expired)
 * - Family invites (some timed-out)
 * - Orders in different states
 * - Duplicate members across groups (for dedup testing)
 * - SystemSchedulerConfig with default values
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function randomId() {
  return Math.random().toString(36).substring(2, 10);
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function main() {
  console.log("🗑️  Clearing all existing data...");

  // Delete in FK order
  await prisma.taskLog.deleteMany();
  await prisma.task.deleteMany();
  await prisma.swapRecord.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.transferBatch.deleteMany();
  await prisma.familyInvite.deleteMany();
  await prisma.familyMember.deleteMany();
  await prisma.order.deleteMany();
  await prisma.redeemCode.deleteMany();
  await prisma.familyGroup.deleteMany();
  await prisma.account.deleteMany();
  await prisma.user.deleteMany();
  await prisma.systemSchedulerConfig.deleteMany();

  console.log("✅ All data cleared");

  // ── Admin User ──
  const passwordHash = "$2b$10$jUY29mJMgshIubcXW2U8QuM03a3oIDSDVWU6bteSqHoGPNk7hAfIu"; // hashed "admin123"
  const admin = await prisma.user.create({
    data: {
      email: "admin@gfa.test",
      passwordHash,
      displayName: "测试管理员",
      role: "ADMIN",
    },
  });
  console.log(`👤 Admin: ${admin.email} / admin123`);

  // ── Accounts ──
  const accounts = await Promise.all([
    prisma.account.create({
      data: {
        name: "母号A-正常",
        loginEmail: "account-a@gmail.com",
        loginPassword: "pass123",
        adspowerProfileId: `profile-a-${randomId()}`,
        status: "HEALTHY",
        lastAutoMaintenanceAt: daysAgo(2), // 2 days ago
      },
    }),
    prisma.account.create({
      data: {
        name: "母号B-正常",
        loginEmail: "account-b@gmail.com",
        loginPassword: "pass123",
        adspowerProfileId: `profile-b-${randomId()}`,
        status: "HEALTHY",
        lastAutoMaintenanceAt: null, // never maintained
      },
    }),
    prisma.account.create({
      data: {
        name: "母号C-正常",
        loginEmail: "account-c@gmail.com",
        loginPassword: "pass123",
        adspowerProfileId: `profile-c-${randomId()}`,
        status: "HEALTHY",
        lastAutoMaintenanceAt: hoursAgo(30), // 30 hours ago
      },
    }),
    prisma.account.create({
      data: {
        name: "母号D-风险",
        loginEmail: "account-d@gmail.com",
        loginPassword: "pass123",
        adspowerProfileId: `profile-d-${randomId()}`,
        status: "RISKY",
        riskScore: 5,
      },
    }),
    prisma.account.create({
      data: {
        name: "母号E-需登录",
        loginEmail: "account-e@gmail.com",
        loginPassword: "pass123",
        adspowerProfileId: `profile-e-${randomId()}`,
        status: "LOGIN_REQUIRED",
      },
    }),
  ]);

  console.log(`📧 ${accounts.length} accounts created`);

  // ── Family Groups ──
  // Account A: 2 groups
  const groupA1 = await prisma.familyGroup.create({
    data: {
      accountId: accounts[0].id,
      groupName: "A-家庭组1",
      maxMembers: 6,
      memberCount: 3,
      availableSlots: 2,
      pendingInviteCount: 1,
      lastSyncedAt: hoursAgo(48), // 48 hours stale → will trigger sync
    },
  });

  const groupA2 = await prisma.familyGroup.create({
    data: {
      accountId: accounts[0].id,
      groupName: "A-家庭组2",
      maxMembers: 6,
      memberCount: 2,
      availableSlots: 3,
      lastSyncedAt: hoursAgo(6), // recent, won't trigger
    },
  });

  // Account B: 2 groups (never synced)
  const groupB1 = await prisma.familyGroup.create({
    data: {
      accountId: accounts[1].id,
      groupName: "B-家庭组1",
      maxMembers: 6,
      memberCount: 4,
      availableSlots: 1,
      pendingInviteCount: 1,
      lastSyncedAt: null, // never synced → will trigger
    },
  });

  const groupB2 = await prisma.familyGroup.create({
    data: {
      accountId: accounts[1].id,
      groupName: "B-家庭组2",
      maxMembers: 6,
      memberCount: 2,
      availableSlots: 3,
      lastSyncedAt: daysAgo(3), // 3 days stale
    },
  });

  // Account C: 2 groups
  const groupC1 = await prisma.familyGroup.create({
    data: {
      accountId: accounts[2].id,
      groupName: "C-家庭组1",
      maxMembers: 6,
      memberCount: 5,
      availableSlots: 0,
      pendingInviteCount: 0,
      lastSyncedAt: hoursAgo(30), // stale
    },
  });

  const groupC2 = await prisma.familyGroup.create({
    data: {
      accountId: accounts[2].id,
      groupName: "C-家庭组2",
      maxMembers: 6,
      memberCount: 1,
      availableSlots: 4,
      lastSyncedAt: hoursAgo(2), // recent
    },
  });

  // Account D (RISKY): 1 group — should NOT be selected by scheduler
  const groupD1 = await prisma.familyGroup.create({
    data: {
      accountId: accounts[3].id,
      groupName: "D-家庭组1-风险账号",
      maxMembers: 6,
      memberCount: 3,
      availableSlots: 2,
      lastSyncedAt: daysAgo(10), // very stale, but account is RISKY
    },
  });

  // Account E (LOGIN_REQUIRED): 1 group - should NOT be selected
  const groupE1 = await prisma.familyGroup.create({
    data: {
      accountId: accounts[4].id,
      groupName: "E-家庭组1-需登录",
      maxMembers: 6,
      memberCount: 2,
      availableSlots: 3,
      lastSyncedAt: daysAgo(5),
    },
  });

  console.log("🏠 8 family groups created");

  // ── Members ──
  // Group A1: owner + 2 active + 1 expired
  await prisma.familyMember.createMany({
    data: [
      {
        familyGroupId: groupA1.id,
        email: "account-a@gmail.com",
        displayName: "母号A",
        role: "OWNER",
        status: "ACTIVE",
      },
      {
        familyGroupId: groupA1.id,
        email: "member1@user.com",
        displayName: "成员1",
        role: "MEMBER",
        status: "ACTIVE",
        expiresAt: daysAgo(1), // expired yesterday!
        joinedAt: daysAgo(35),
      },
      {
        familyGroupId: groupA1.id,
        email: "member2@user.com",
        displayName: "成员2",
        role: "MEMBER",
        status: "ACTIVE",
        expiresAt: daysFromNow(20),
        joinedAt: daysAgo(10),
      },
      {
        familyGroupId: groupA1.id,
        email: "pending1@user.com",
        displayName: "待接受1",
        role: "MEMBER",
        status: "PENDING",
      },
    ],
  });

  // Group A2: owner + 1 active
  await prisma.familyMember.createMany({
    data: [
      {
        familyGroupId: groupA2.id,
        email: "account-a@gmail.com",
        displayName: "母号A",
        role: "OWNER",
        status: "ACTIVE",
      },
      {
        familyGroupId: groupA2.id,
        email: "member3@user.com",
        displayName: "成员3",
        role: "MEMBER",
        status: "ACTIVE",
        expiresAt: daysFromNow(15),
      },
    ],
  });

  // Group B1: owner + 3 members (1 pending) + duplicate member
  await prisma.familyMember.createMany({
    data: [
      {
        familyGroupId: groupB1.id,
        email: "account-b@gmail.com",
        displayName: "母号B",
        role: "OWNER",
        status: "ACTIVE",
      },
      {
        familyGroupId: groupB1.id,
        email: "member4@user.com",
        displayName: "成员4",
        role: "MEMBER",
        status: "ACTIVE",
        expiresAt: daysAgo(3), // expired 3 days ago!
      },
      {
        familyGroupId: groupB1.id,
        email: "member5@user.com",
        displayName: "成员5",
        role: "MEMBER",
        status: "ACTIVE",
        expiresAt: daysFromNow(25),
      },
      // DUPLICATE: member1 is also in group A1 (ACTIVE there, PENDING here)
      {
        familyGroupId: groupB1.id,
        email: "member1@user.com",
        displayName: "成员1-重复",
        role: "MEMBER",
        status: "PENDING",
      },
    ],
  });

  // Group B2: owner + 1 active
  await prisma.familyMember.createMany({
    data: [
      {
        familyGroupId: groupB2.id,
        email: "account-b@gmail.com",
        displayName: "母号B",
        role: "OWNER",
        status: "ACTIVE",
      },
      {
        familyGroupId: groupB2.id,
        email: "member6@user.com",
        displayName: "成员6",
        role: "MEMBER",
        status: "ACTIVE",
        expiresAt: daysFromNow(10),
      },
    ],
  });

  // Group C1: owner + 4 active (2 expired)
  await prisma.familyMember.createMany({
    data: [
      {
        familyGroupId: groupC1.id,
        email: "account-c@gmail.com",
        displayName: "母号C",
        role: "OWNER",
        status: "ACTIVE",
      },
      {
        familyGroupId: groupC1.id,
        email: "member7@user.com",
        displayName: "成员7",
        role: "MEMBER",
        status: "ACTIVE",
        expiresAt: hoursAgo(2), // just expired
      },
      {
        familyGroupId: groupC1.id,
        email: "member8@user.com",
        displayName: "成员8",
        role: "MEMBER",
        status: "ACTIVE",
        expiresAt: daysFromNow(5),
      },
      {
        familyGroupId: groupC1.id,
        email: "member9@user.com",
        displayName: "成员9",
        role: "MEMBER",
        status: "ACTIVE",
        expiresAt: daysAgo(7), // expired a week ago
      },
      // DUPLICATE across accounts: member5 also in B1 (ACTIVE there, PENDING here — dedup should cancel this)
      {
        familyGroupId: groupC1.id,
        email: "member5@user.com",
        displayName: "成员5-跨号重复",
        role: "MEMBER",
        status: "PENDING",
      },
    ],
  });

  // Group C2: owner only
  await prisma.familyMember.createMany({
    data: [
      {
        familyGroupId: groupC2.id,
        email: "account-c@gmail.com",
        displayName: "母号C",
        role: "OWNER",
        status: "ACTIVE",
      },
    ],
  });

  console.log("👥 Members created (including duplicates for dedup test)");

  // ── Invites ──
  // Group A1: 1 timed-out invite (sent 5 days ago)
  await prisma.familyInvite.create({
    data: {
      familyGroupId: groupA1.id,
      email: "pending1@user.com",
      status: "SENT",
      sentAt: daysAgo(5), // 5 days > 3 day timeout
    },
  });

  // Group B1: 1 recent invite (should NOT be cancelled)
  await prisma.familyInvite.create({
    data: {
      familyGroupId: groupB1.id,
      email: "member1@user.com",
      status: "SENT",
      sentAt: hoursAgo(12), // only 12 hours, not timed out
    },
  });

  // Group C1: 1 timed-out invite
  await prisma.familyInvite.create({
    data: {
      familyGroupId: groupC1.id,
      email: "member5@user.com",
      status: "SENT",
      sentAt: daysAgo(4), // 4 days > 3 day timeout
    },
  });

  console.log("📨 Invites created (some timed-out)");

  // ── Orders ──
  // Order for expired member1 in A1
  await prisma.order.create({
    data: {
      orderNo: `ORD-${Date.now()}-001`,
      userEmail: "member1@user.com",
      familyGroupId: groupA1.id,
      status: "COMPLETED",
      expiresAt: daysAgo(1),
    },
  });

  // Order for pending1 (invite timed out)
  await prisma.order.create({
    data: {
      orderNo: `ORD-${Date.now()}-002`,
      userEmail: "pending1@user.com",
      familyGroupId: groupA1.id,
      status: "WAIT_USER_ACCEPT",
    },
  });

  // Order for expired member4 in B1
  await prisma.order.create({
    data: {
      orderNo: `ORD-${Date.now()}-003`,
      userEmail: "member4@user.com",
      familyGroupId: groupB1.id,
      status: "COMPLETED",
      expiresAt: daysAgo(3),
    },
  });

  // Order for member5 (duplicate pending in C1)
  await prisma.order.create({
    data: {
      orderNo: `ORD-${Date.now()}-004`,
      userEmail: "member5@user.com",
      familyGroupId: groupC1.id,
      status: "INVITE_SENT",
    },
  });

  // Order for expired member7 in C1
  await prisma.order.create({
    data: {
      orderNo: `ORD-${Date.now()}-005`,
      userEmail: "member7@user.com",
      familyGroupId: groupC1.id,
      status: "COMPLETED",
      expiresAt: hoursAgo(2),
    },
  });

  // Order for expired member9 in C1
  await prisma.order.create({
    data: {
      orderNo: `ORD-${Date.now()}-006`,
      userEmail: "member9@user.com",
      familyGroupId: groupC1.id,
      status: "COMPLETED",
      expiresAt: daysAgo(7),
    },
  });

  // Some "already completed" orders (should not be touched)
  await prisma.order.create({
    data: {
      orderNo: `ORD-${Date.now()}-007`,
      userEmail: "member2@user.com",
      familyGroupId: groupA1.id,
      status: "COMPLETED",
      expiresAt: daysFromNow(20),
    },
  });

  // Some previous scheduler-cancelled orders (for display test)
  await prisma.order.create({
    data: {
      orderNo: `ORD-${Date.now()}-008`,
      userEmail: "old-dup@user.com",
      familyGroupId: groupA1.id,
      status: "FAILED",
      resultMessage: "重复取消：成员已在其他组内",
    },
  });

  await prisma.order.create({
    data: {
      orderNo: `ORD-${Date.now()}-009`,
      userEmail: "old-timeout@user.com",
      familyGroupId: groupB1.id,
      status: "FAILED",
      resultMessage: "定时取消：邀请超时（3天未接受）",
    },
  });

  console.log("📋 Orders created");

  // ── Some redeem codes ──
  await prisma.redeemCode.createMany({
    data: Array.from({ length: 5 }, (_, i) => ({
      code: `TEST-${Date.now()}-${String(i + 1).padStart(3, "0")}`,
      product: "GOOGLE_ONE",
      status: "UNUSED" as any,
    })),
  });

  console.log("🎫 5 redeem codes created");

  // ── Scheduler Config (default) ──
  await prisma.systemSchedulerConfig.create({
    data: {
      id: "default",
      enabled: false, // off by default for safety
      maxAccountsPerRun: 10,
      accountCooldownMinutes: 60,
      runWindowStart: "22:00",
      runWindowEnd: "08:00",
      staleSyncThresholdMinutes: 1440,
      syncEnabled: true,
      removeExpiredMembersEnabled: true,
      cancelTimedOutInvitesEnabled: true,
      deduplicateMembersEnabled: true,
      inviteTimeoutDays: 3,
    },
  });

  console.log("⚙️  Scheduler config created (disabled by default)");

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════");
  console.log("📊 Test Data Summary:");
  console.log("═══════════════════════════════════════════");
  console.log(`  Accounts: 5 (3 HEALTHY, 1 RISKY, 1 LOGIN_REQUIRED)`);
  console.log(`  Family Groups: 8`);
  console.log(`  Expired Members: member1, member4, member7, member9`);
  console.log(`  Timed-out Invites: pending1@user.com (5d), member5@user.com (4d)`);
  console.log(`  Duplicate Members: member1 (A1+B1), member5 (B1+C1)`);
  console.log(`  Stale Groups (>24h): A1(48h), B1(never), B2(3d), C1(30h)`);
  console.log(`  RISKY/LOGIN_REQUIRED Accounts: D & E (should NOT be selected)`);
  console.log(`  Scheduler-cancelled Orders: 2 (for display test)`);
  console.log(`\n  Admin login: admin@gfa.test / admin123`);
  console.log("═══════════════════════════════════════════\n");
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
