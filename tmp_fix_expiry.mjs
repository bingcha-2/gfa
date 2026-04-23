/**
 * Fix script v3: Only fix MIGRATED members' expiresAt to their ORIGINAL
 * group's account subscriptionExpiresAt.
 *
 * Only targets members who were migrated (original group ≠ current group).
 * Skips manually edited members.
 *
 * DRY RUN by default. Pass --apply to execute.
 */
import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
const DRY_RUN = !process.argv.includes('--apply');

if (DRY_RUN) {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           DRY RUN MODE (no changes)             ║');
  console.log('║      Pass --apply to actually fix records        ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
} else {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║          ⚠️  LIVE MODE - APPLYING FIXES          ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
}

try {
  // 1. Get manually edited member IDs to exclude
  const manualEdits = await p.auditLog.findMany({
    where: {
      action: 'UPDATE_MEMBER_DATES',
      targetType: 'FamilyMember',
    },
    select: { targetId: true }
  });
  const manuallyEditedIds = new Set(manualEdits.map(a => a.targetId));

  // 2. Get all ACTIVE non-owner members with expiresAt
  const activeMembers = await p.familyMember.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { not: null },
      role: { not: 'OWNER' }
    },
    include: {
      familyGroup: {
        include: {
          account: {
            select: {
              id: true,
              loginEmail: true,
              subscriptionExpiresAt: true,
            }
          }
        }
      }
    }
  });

  // 3. Batch-query full history for all emails
  const emails = [...new Set(activeMembers.map(m => m.email))];

  const allRecords = await p.familyMember.findMany({
    where: { email: { in: emails } },
    include: {
      familyGroup: {
        include: {
          account: {
            select: {
              id: true,
              loginEmail: true,
              subscriptionExpiresAt: true,
            }
          }
        }
      }
    },
    orderBy: { createdAt: 'asc' }
  });

  // email -> earliest record (original group)
  const originalGroupMap = new Map();
  for (const r of allRecords) {
    if (!originalGroupMap.has(r.email)) {
      originalGroupMap.set(r.email, r);
    }
  }

  // Fallback: Order records
  const orders = await p.order.findMany({
    where: {
      userEmail: { in: emails },
      status: { in: ['COMPLETED', 'INVITE_SENT', 'WAIT_USER_ACCEPT'] },
    },
    include: {
      familyGroup: {
        include: {
          account: {
            select: {
              id: true,
              loginEmail: true,
              subscriptionExpiresAt: true,
            }
          }
        }
      }
    },
    orderBy: { createdAt: 'asc' }
  });

  const orderGroupMap = new Map();
  for (const o of orders) {
    if (!orderGroupMap.has(o.userEmail) && o.familyGroup) {
      orderGroupMap.set(o.userEmail, o);
    }
  }

  // 4. Build fix list — ONLY migrated members
  const fixes = [];
  let skippedManual = 0;
  let skippedNoExpiry = 0;
  let skippedAlreadyCorrect = 0;
  let skippedNotMigrated = 0;

  for (const m of activeMembers) {
    const currentGroupId = m.familyGroupId;

    // Find original account's subscriptionExpiresAt
    const originalRecord = originalGroupMap.get(m.email);
    const originalOrder = orderGroupMap.get(m.email);

    let correctExpiresAt = null;
    let originalGroupName = null;
    let originalAccountEmail = null;
    let originalGroupId = null;

    if (originalRecord) {
      correctExpiresAt = originalRecord.familyGroup?.account?.subscriptionExpiresAt;
      originalGroupName = originalRecord.familyGroup?.groupName;
      originalAccountEmail = originalRecord.familyGroup?.account?.loginEmail;
      originalGroupId = originalRecord.familyGroupId;
    }

    if (!correctExpiresAt && originalOrder) {
      correctExpiresAt = originalOrder.familyGroup?.account?.subscriptionExpiresAt;
      originalGroupName = originalGroupName || originalOrder.familyGroup?.groupName;
      originalAccountEmail = originalAccountEmail || originalOrder.familyGroup?.account?.loginEmail;
      originalGroupId = originalGroupId || originalOrder.familyGroupId;
    }

    // *** KEY: Only fix migrated members (original group ≠ current group) ***
    const wasMigrated = originalGroupId && originalGroupId !== currentGroupId;
    if (!wasMigrated) {
      skippedNotMigrated++;
      continue;
    }

    if (!correctExpiresAt) {
      skippedNoExpiry++;
      continue;
    }

    // Check if already correct (within 1 day)
    const memberExpiry = m.expiresAt.getTime();
    const targetExpiry = correctExpiresAt.getTime();
    const diffDays = Math.abs(memberExpiry - targetExpiry) / (24 * 60 * 60 * 1000);

    if (diffDays <= 1) {
      skippedAlreadyCorrect++;
      continue;
    }

    // Skip manually edited
    if (manuallyEditedIds.has(m.id)) {
      skippedManual++;
      continue;
    }

    fixes.push({
      memberId: m.id,
      email: m.email,
      oldExpiresAt: m.expiresAt.toISOString(),
      newExpiresAt: correctExpiresAt.toISOString(),
      diffDays: diffDays.toFixed(1),
      currentGroup: m.familyGroup?.groupName,
      originalGroup: originalGroupName,
      originalAcctEmail: originalAccountEmail,
    });
  }

  // 5. Report
  console.log(`=== FIX PLAN (migrated members only) ===`);
  console.log(`Members to fix: ${fixes.length}`);
  console.log(`Skipped (not migrated): ${skippedNotMigrated}`);
  console.log(`Skipped (manually edited): ${skippedManual}`);
  console.log(`Skipped (no expiry info): ${skippedNoExpiry}`);
  console.log(`Skipped (already correct): ${skippedAlreadyCorrect}`);

  if (fixes.length > 0) {
    console.log(`\nAll changes:`);
    console.table(fixes.map(f => ({
      email: f.email,
      oldExp: f.oldExpiresAt.slice(0, 10),
      newExp: f.newExpiresAt.slice(0, 10),
      diff: f.diffDays + 'd',
      curGroup: f.currentGroup?.slice(0, 20),
      origGroup: f.originalGroup?.slice(0, 20),
      origAcct: f.originalAcctEmail?.slice(0, 22),
    })));
  }

  // 6. Apply if not dry run
  if (DRY_RUN) {
    console.log(`\n⚠️ DRY RUN: No changes made. Run with --apply to fix ${fixes.length} members.`);
  } else {
    const BATCH_SIZE = 50;
    let fixedCount = 0;

    for (let i = 0; i < fixes.length; i += BATCH_SIZE) {
      const batch = fixes.slice(i, i + BATCH_SIZE);

      await p.$transaction(
        batch.map(f =>
          p.familyMember.update({
            where: { id: f.memberId },
            data: { expiresAt: new Date(f.newExpiresAt) }
          })
        )
      );

      fixedCount += batch.length;
      console.log(`  Fixed ${fixedCount}/${fixes.length}...`);
    }

    console.log(`\n✅ Fixed ${fixedCount} migrated members' expiresAt to their original account's subscriptionExpiresAt.`);
  }

} catch (err) {
  console.error('Error:', err);
} finally {
  await p.$disconnect();
}
