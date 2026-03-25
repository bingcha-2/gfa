/**
 * Seed test data for worker E2E testing.
 *
 * Creates a test Account and FamilyGroup in the database.
 * The adspowerProfileId must match an actual profile in your AdsPower.
 *
 * Usage:
 *   npx tsx scripts/seed-test-data.ts <adspower_profile_id>
 *
 * Example:
 *   npx tsx scripts/seed-test-data.ts jf8k2m
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const profileId = process.argv[2];
  if (!profileId) {
    console.error(
      "Usage: npx tsx scripts/seed-test-data.ts <adspower_profile_id>\n\n" +
        "Find your profile ID in AdsPower → Profile List → serial_number column"
    );
    process.exit(1);
  }

  // Check if account already exists
  const existing = await prisma.account.findFirst({
    where: { adspowerProfileId: profileId },
  });

  if (existing) {
    console.log(`Account already exists for profile ${profileId}:`);
    console.log(`  id: ${existing.id}`);
    console.log(`  name: ${existing.name}`);
    return;
  }

  // Create test account
  const account = await prisma.account.create({
    data: {
      name: "Test Account",
      loginEmail: "test@gmail.com",
      adspowerProfileId: profileId,
      status: "HEALTHY",
    },
  });
  console.log(`✅ Account created: ${account.id}`);

  // Create test family group
  const group = await prisma.familyGroup.create({
    data: {
      accountId: account.id,
      groupName: "Test Family",
      maxMembers: 6,
      memberCount: 1,
      availableSlots: 5,
      status: "ACTIVE",
    },
  });
  console.log(`✅ FamilyGroup created: ${group.id}`);

  // Create a test task (PENDING) for health check
  const task = await prisma.task.create({
    data: {
      type: "HEALTH_CHECK_ACCOUNT",
      accountId: account.id,
      status: "PENDING",
      payload: JSON.stringify({ accountId: account.id }),
    },
  });
  console.log(`✅ Test Task created: ${task.id}`);

  console.log("\nReady! Run the worker:");
  console.log("  pnpm --filter @gfa/worker dev");
  console.log("\nThen enqueue a job:");
  console.log("  npx tsx scripts/test-worker.ts health");
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
    process.exit(1);
  });
