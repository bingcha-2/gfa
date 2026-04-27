/**
 * Check: among the 71 updated groups, how many are ACTIVE vs MANUAL_ONLY?
 * Also show how many actual slots were freed (availableSlots increased).
 */

import { PrismaClient } from "@prisma/client";

const NON_ADMIN_CAPACITY = 5;

async function main() {
  const prisma = new PrismaClient();

  try {
    // Re-check: find groups where the stored counts DON'T match DB reality
    // (after the fix, they should all match now — so instead, find groups
    //  where availableSlots > 0 that were previously 0, indicating freed slots)
    
    // Approach: just show ALL groups with their status and current counts
    // to answer the user's question about MANUAL_ONLY
    const groups = await prisma.familyGroup.findMany({
      select: {
        id: true,
        groupName: true,
        status: true,
        memberCount: true,
        availableSlots: true,
      },
    });

    // Summary by status
    const byStatus: Record<string, { total: number; withSlots: number; totalSlots: number }> = {};

    for (const g of groups) {
      if (!byStatus[g.status]) {
        byStatus[g.status] = { total: 0, withSlots: 0, totalSlots: 0 };
      }
      byStatus[g.status].total++;
      if (g.availableSlots > 0) {
        byStatus[g.status].withSlots++;
        byStatus[g.status].totalSlots += g.availableSlots;
      }
    }

    console.log("=== 按状态统计 ===\n");
    console.log(
      "Status".padEnd(15) +
      "Total Groups".padEnd(15) +
      "Groups w/ Slots".padEnd(18) +
      "Total Free Slots"
    );
    console.log("─".repeat(65));
    for (const [status, info] of Object.entries(byStatus)) {
      console.log(
        status.padEnd(15) +
        String(info.total).padEnd(15) +
        String(info.withSlots).padEnd(18) +
        String(info.totalSlots)
      );
    }

    // Now specifically: groups where availableSlots > 0 AND status is NOT ACTIVE
    const manualWithSlots = groups.filter(
      (g) => g.availableSlots > 0 && g.status !== "ACTIVE"
    );

    if (manualWithSlots.length > 0) {
      console.log(`\n=== 非 ACTIVE 状态但有空位的组 (${manualWithSlots.length} 个) ===\n`);
      console.log(
        "Group Name".padEnd(30) +
        "Status".padEnd(15) +
        "Members".padEnd(10) +
        "Slots"
      );
      console.log("─".repeat(65));
      for (const g of manualWithSlots) {
        console.log(
          (g.groupName ?? g.id.slice(0, 25)).padEnd(30) +
          g.status.padEnd(15) +
          String(g.memberCount).padEnd(10) +
          String(g.availableSlots)
        );
      }
    } else {
      console.log("\n✓ 所有有空位的组都是 ACTIVE 状态");
    }

    // ACTIVE groups with available slots (the ones that actually matter for auto-assign)
    const activeWithSlots = groups.filter(
      (g) => g.availableSlots > 0 && g.status === "ACTIVE"
    );
    const totalActiveSlots = activeWithSlots.reduce((sum, g) => sum + g.availableSlots, 0);
    console.log(`\n=== 可自动分配的席位 ===`);
    console.log(`ACTIVE 组中有空位的: ${activeWithSlots.length} 个组，共 ${totalActiveSlots} 个空位`);

  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
