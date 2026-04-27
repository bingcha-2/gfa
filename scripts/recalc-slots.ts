/**
 * One-off script: recalculate memberCount and availableSlots for all family groups
 * based on actual FamilyMember records in the database.
 *
 * Usage: npx tsx scripts/recalc-slots.ts
 */

import { PrismaClient } from "@prisma/client";

const NON_ADMIN_CAPACITY = 5;

async function main() {
  const prisma = new PrismaClient();

  try {
    const groups = await prisma.familyGroup.findMany({
      select: {
        id: true,
        groupName: true,
        memberCount: true,
        availableSlots: true,
        accountId: true,
        account: { select: { loginEmail: true } },
      },
    });

    console.log(`Found ${groups.length} family group(s)\n`);
    console.log("─".repeat(100));
    console.log(
      "Group Name".padEnd(25) +
      "Old Count".padEnd(12) +
      "New Count".padEnd(12) +
      "Old Slots".padEnd(12) +
      "New Slots".padEnd(12) +
      "Changed"
    );
    console.log("─".repeat(100));

    let updatedCount = 0;

    for (const group of groups) {
      const adminEmail = (group.account?.loginEmail ?? "").trim().toLowerCase();

      const activeMembers = await prisma.familyMember.count({
        where: {
          familyGroupId: group.id,
          status: { in: ["ACTIVE", "PENDING"] },
          ...(adminEmail ? { email: { not: adminEmail } } : {}),
        },
      });

      const computedSlots = Math.max(0, NON_ADMIN_CAPACITY - activeMembers);
      const changed =
        group.memberCount !== activeMembers ||
        group.availableSlots !== computedSlots;

      console.log(
        (group.groupName ?? group.id.slice(0, 20)).padEnd(25) +
        String(group.memberCount).padEnd(12) +
        String(activeMembers).padEnd(12) +
        String(group.availableSlots).padEnd(12) +
        String(computedSlots).padEnd(12) +
        (changed ? "✗ → UPDATED" : "✓")
      );

      if (changed) {
        await prisma.familyGroup.update({
          where: { id: group.id },
          data: {
            memberCount: activeMembers,
            availableSlots: computedSlots,
          },
        });
        updatedCount++;
      }
    }

    console.log("─".repeat(100));
    console.log(`\nDone. Updated ${updatedCount} of ${groups.length} group(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
