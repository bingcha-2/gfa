/**
 * Diagnostic v2: Trace each member back to their ORIGINAL group/account
 * to determine the correct expiresAt.
 *
 * For each ACTIVE member:
 *   1. Find all FamilyMember records for that email (including REMOVED)
 *   2. The earliest record = original group
 *   3. Original group's account's subscriptionExpiresAt = correct expiresAt
 *   4. Compare with current expiresAt
 */
import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

try {
  // 1. Get all ACTIVE non-owner members with expiresAt
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

  console.log(`Total ACTIVE non-owner members with expiresAt: ${activeMembers.length}\n`);

  // 2. Collect all emails to batch-query their full history
  const emails = [...new Set(activeMembers.map(m => m.email))];
  
  // 3. Find ALL FamilyMember records (any status) for these emails, ordered by createdAt asc
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

  // 4. Build a map: email -> earliest record (original group)
  const originalGroupMap = new Map();
  for (const r of allRecords) {
    if (!originalGroupMap.has(r.email)) {
      originalGroupMap.set(r.email, r);
    }
  }

  // 5. Also check Order records as another source of original group
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

  // email -> earliest order's group
  const orderGroupMap = new Map();
  for (const o of orders) {
    if (!orderGroupMap.has(o.userEmail) && o.familyGroup) {
      orderGroupMap.set(o.userEmail, o);
    }
  }

  // 6. Get manually edited member IDs
  const manualEdits = await p.auditLog.findMany({
    where: {
      action: 'UPDATE_MEMBER_DATES',
      targetType: 'FamilyMember',
    },
    select: { targetId: true }
  });
  const manuallyEditedIds = new Set(manualEdits.map(a => a.targetId));

  // 7. Analyze each active member
  const results = {
    needsFix: [],
    alreadyCorrect: [],
    manuallyEdited: [],
    noOriginalExpiry: [],
    sameSameGroup: [],  // never migrated, original == current
  };

  for (const m of activeMembers) {
    const currentGroupId = m.familyGroupId;
    const currentAccountSubExpiry = m.familyGroup?.account?.subscriptionExpiresAt;
    
    // Find original record
    const originalRecord = originalGroupMap.get(m.email);
    const originalOrder = orderGroupMap.get(m.email);
    
    // Determine original account's subscriptionExpiresAt
    // Priority: earliest FamilyMember record's group -> earliest Order's group
    let originalAccountSubExpiry = null;
    let originalGroupName = null;
    let originalAccountEmail = null;
    let wasMigrated = false;

    if (originalRecord) {
      originalAccountSubExpiry = originalRecord.familyGroup?.account?.subscriptionExpiresAt;
      originalGroupName = originalRecord.familyGroup?.groupName;
      originalAccountEmail = originalRecord.familyGroup?.account?.loginEmail;
      wasMigrated = originalRecord.familyGroupId !== currentGroupId;
    }

    // Fallback to order if original record's group has no subscription info
    if (!originalAccountSubExpiry && originalOrder) {
      originalAccountSubExpiry = originalOrder.familyGroup?.account?.subscriptionExpiresAt;
      originalGroupName = originalGroupName || originalOrder.familyGroup?.groupName;
      originalAccountEmail = originalAccountEmail || originalOrder.familyGroup?.account?.loginEmail;
      if (originalOrder.familyGroupId !== currentGroupId) wasMigrated = true;
    }

    // If still no original expiry, fall back to current account's
    if (!originalAccountSubExpiry) {
      if (!currentAccountSubExpiry) {
        results.noOriginalExpiry.push({
          email: m.email,
          currentGroup: m.familyGroup?.groupName,
          memberExpiresAt: m.expiresAt?.toISOString()?.slice(0, 10),
        });
        continue;
      }
      // Use current account's expiry as fallback
      originalAccountSubExpiry = currentAccountSubExpiry;
      originalGroupName = m.familyGroup?.groupName;
      originalAccountEmail = m.familyGroup?.account?.loginEmail;
    }

    // Compare
    const memberExpiry = m.expiresAt.getTime();
    const correctExpiry = originalAccountSubExpiry.getTime();
    const diffMs = Math.abs(memberExpiry - correctExpiry);
    const diffDays = diffMs / (24 * 60 * 60 * 1000);

    if (diffDays <= 1) {
      results.alreadyCorrect.push(m.email);
      continue;
    }

    // Skip manually edited
    if (manuallyEditedIds.has(m.id)) {
      results.manuallyEdited.push({
        email: m.email,
        memberExpiry: m.expiresAt.toISOString().slice(0, 10),
        correctExpiry: originalAccountSubExpiry.toISOString().slice(0, 10),
        diffDays: diffDays.toFixed(1),
      });
      continue;
    }

    results.needsFix.push({
      memberId: m.id,
      email: m.email,
      currentExpiresAt: m.expiresAt.toISOString(),
      correctExpiresAt: originalAccountSubExpiry.toISOString(),
      diffDays: diffDays.toFixed(1),
      wasMigrated,
      currentGroup: m.familyGroup?.groupName,
      originalGroup: originalGroupName,
      originalAcctEmail: originalAccountEmail,
    });
  }

  // Print results
  console.log(`\n=== SUMMARY ===`);
  console.log(`Already correct: ${results.alreadyCorrect.length}`);
  console.log(`Needs fix: ${results.needsFix.length}`);
  console.log(`  - Migrated members: ${results.needsFix.filter(x => x.wasMigrated).length}`);
  console.log(`  - Non-migrated (same group): ${results.needsFix.filter(x => !x.wasMigrated).length}`);
  console.log(`Manually edited (skip): ${results.manuallyEdited.length}`);
  console.log(`No original expiry info: ${results.noOriginalExpiry.length}`);

  console.log(`\n=== MEMBERS NEEDING FIX (first 30) ===`);
  console.table(results.needsFix.slice(0, 30).map(r => ({
    email: r.email,
    currentExp: r.currentExpiresAt.slice(0, 10),
    correctExp: r.correctExpiresAt.slice(0, 10),
    diff: r.diffDays + 'd',
    migrated: r.wasMigrated ? '✓' : '',
    curGroup: r.currentGroup?.slice(0, 20),
    origGroup: r.originalGroup?.slice(0, 20),
    origAcct: r.originalAcctEmail?.slice(0, 22),
  })));

  // Show migrated members specifically
  const migrated = results.needsFix.filter(x => x.wasMigrated);
  if (migrated.length > 0) {
    console.log(`\n=== MIGRATED MEMBERS (first 30) ===`);
    console.table(migrated.slice(0, 30).map(r => ({
      email: r.email,
      currentExp: r.currentExpiresAt.slice(0, 10),
      correctExp: r.correctExpiresAt.slice(0, 10),
      diff: r.diffDays + 'd',
      curGroup: r.currentGroup?.slice(0, 20),
      origGroup: r.originalGroup?.slice(0, 20),
      origAcct: r.originalAcctEmail?.slice(0, 22),
    })));
  }

  if (results.manuallyEdited.length > 0) {
    console.log(`\n=== MANUALLY EDITED (skipped, first 20) ===`);
    console.table(results.manuallyEdited.slice(0, 20));
  }

  if (results.noOriginalExpiry.length > 0) {
    console.log(`\n=== NO ORIGINAL EXPIRY INFO (skipped) ===`);
    console.table(results.noOriginalExpiry);
  }

} finally {
  await p.$disconnect();
}
