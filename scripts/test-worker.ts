/**
 * Test harness for the Automation Worker.
 *
 * Usage:
 *   pnpm --filter @gfa/worker exec tsx ../../scripts/test-worker.ts health
 *   pnpm --filter @gfa/worker exec tsx ../../scripts/test-worker.ts sync
 *   pnpm --filter @gfa/worker exec tsx ../../scripts/test-worker.ts invite <email>
 *   pnpm --filter @gfa/worker exec tsx ../../scripts/test-worker.ts list
 *
 * Prerequisites:
 *   1. Redis running on localhost:6379
 *   2. AdsPower running with Local API enabled
 *   3. Database has at least one Account with a valid adspowerProfileId
 *
 * IMPORTANT: Each enqueue creates a Task record in DB first, then passes
 * its cuid as BullMQ jobId. This ensures the worker's TaskLogger can
 * find and update the Task by id.
 */

import "dotenv/config";
import { Queue } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { QUEUE_NAMES } from "@gfa/shared";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || "localhost",
    port: parseInt(parsed.port, 10) || 6379,
    password: parsed.password || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
  };
}

const connection = parseRedisUrl(redisUrl);
const prisma = new PrismaClient();

async function listData() {
  const accounts = await prisma.account.findMany({
    select: {
      id: true,
      name: true,
      loginEmail: true,
      adspowerProfileId: true,
      status: true,
    },
  });

  console.log("\n=== Accounts ===");
  if (accounts.length === 0) {
    console.log("(none — run seed first)");
  }
  for (const a of accounts) {
    console.log(
      `  ${a.id} | ${a.name} | ${a.loginEmail} | profile=${a.adspowerProfileId} | ${a.status}`
    );
  }

  const groups = await prisma.familyGroup.findMany({
    select: {
      id: true,
      groupName: true,
      accountId: true,
      memberCount: true,
      availableSlots: true,
      status: true,
    },
  });

  console.log("\n=== Family Groups ===");
  if (groups.length === 0) {
    console.log("(none)");
  }
  for (const g of groups) {
    console.log(
      `  ${g.id} | ${g.groupName} | account=${g.accountId} | members=${g.memberCount} slots=${g.availableSlots} | ${g.status}`
    );
  }
}

async function enqueueHealth(accountId: string) {
  const payload = { accountId };

  // Create Task record in DB first
  const task = await prisma.task.create({
    data: {
      type: "HEALTH_CHECK_ACCOUNT",
      accountId,
      status: "PENDING",
      payload: JSON.stringify(payload),
    },
  });

  const queue = new Queue(QUEUE_NAMES.health, { connection });
  const job = await queue.add("health-check", payload, {
    jobId: task.id, // Use DB task cuid as BullMQ jobId
    removeOnComplete: 50,
    removeOnFail: 100,
  });
  console.log(`✅ Health check job enqueued: jobId=${job.id} (taskId=${task.id})`);
  await queue.close();
}

async function enqueueSync(accountId: string, familyGroupId: string) {
  const payload = { accountId, familyGroupId };

  const task = await prisma.task.create({
    data: {
      type: "SYNC_FAMILY_GROUP",
      accountId,
      familyGroupId,
      status: "PENDING",
      payload: JSON.stringify(payload),
    },
  });

  const queue = new Queue(QUEUE_NAMES.sync, { connection });
  const job = await queue.add("sync-family", payload, {
    jobId: task.id,
    removeOnComplete: 50,
    removeOnFail: 100,
  });
  console.log(`✅ Sync job enqueued: jobId=${job.id} (taskId=${task.id})`);
  await queue.close();
}

async function enqueueInvite(
  accountId: string,
  familyGroupId: string,
  userEmail: string
) {
  const payload = { accountId, familyGroupId, userEmail };

  const task = await prisma.task.create({
    data: {
      type: "INVITE_MEMBER",
      accountId,
      familyGroupId,
      status: "PENDING",
      payload: JSON.stringify(payload),
    },
  });

  const queue = new Queue(QUEUE_NAMES.invite, { connection });
  const job = await queue.add("invite-member", payload, {
    jobId: task.id,
    removeOnComplete: 50,
    removeOnFail: 100,
  });
  console.log(`✅ Invite job enqueued: jobId=${job.id} (taskId=${task.id})`);
  await queue.close();
}

// ---- Main ----

async function main() {
  const command = process.argv[2];

  if (!command || command === "list") {
    await listData();
    await prisma.$disconnect();
    return;
  }

  // For health/sync/invite, get first account from DB
  const account = await prisma.account.findFirst();
  if (!account) {
    console.error(
      "❌ No accounts in database. Create one first:\n" +
        "  pnpm --filter @gfa/worker exec tsx ../../scripts/seed-test-data.ts <profile_id>"
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`Using account: ${account.name} (${account.id})`);
  console.log(`AdsPower profile: ${account.adspowerProfileId}`);

  switch (command) {
    case "health": {
      await enqueueHealth(account.id);
      break;
    }
    case "sync": {
      const group = await prisma.familyGroup.findFirst({
        where: { accountId: account.id },
      });
      if (!group) {
        console.error("❌ No family group for this account");
        process.exit(1);
      }
      console.log(`Using group: ${group.groupName} (${group.id})`);
      await enqueueSync(account.id, group.id);
      break;
    }
    case "invite": {
      const email = process.argv[3];
      if (!email) {
        console.error("Usage: test-worker.ts invite <email>");
        process.exit(1);
      }
      const group = await prisma.familyGroup.findFirst({
        where: { accountId: account.id },
      });
      if (!group) {
        console.error("❌ No family group for this account");
        process.exit(1);
      }
      console.log(`Using group: ${group.groupName} (${group.id})`);
      await enqueueInvite(account.id, group.id, email);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: test-worker.ts [list|health|sync|invite]");
      process.exit(1);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
