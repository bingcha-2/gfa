/**
 * Diagnostic script: Find members whose expiresAt was likely reset to ~30 days
 * during migration, when it should match the account's subscriptionExpiresAt.
 *
 * Logic:
 * 1. For each ACTIVE FamilyMember with an expiresAt
 * 2. Look up the Account.subscriptionExpiresAt of their group's owner
 * 3. If member.expiresAt differs from account.subscriptionExpiresAt, flag it
 * 4. Also check if the member was recently involved in a TransferBatch or
 *    has audit logs indicating migration
 *
 * Additionally, check for members whose expiresAt looks like "joinedAt + 30 days"
 * which is the symptom of the bug.
 */
import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

try {
  // 1. Get all active members with expiresAt set
  const members = await p.familyMember.findMany({
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
              subscriptionStatus: true
            }
          }
        }
      }
    },
    orderBy: { expiresAt: 'asc' }
  });

  console.log(`\nTotal ACTIVE non-owner members with expiresAt: ${members.length}\n`);

  // Categorize members
  const mismatchedMembers = [];
  const matchedMembers = [];
  const accountNoSubExpiry = [];

  for (const m of members) {
    const acct = m.familyGroup?.account;
    const accountSubExpiry = acct?.subscriptionExpiresAt;

    if (!accountSubExpiry) {
      accountNoSubExpiry.push({
        memberId: m.id,
        email: m.email,
        memberExpiresAt: m.expiresAt?.toISOString(),
        groupName: m.familyGroup?.groupName,
        accountEmail: acct?.loginEmail,
        joinedAt: m.joinedAt?.toISOString(),
      });
      continue;
    }

    // Compare: is member's expiresAt within 1 day of account's subscriptionExpiresAt?
    const memberExpiry = m.expiresAt.getTime();
    const accountExpiry = accountSubExpiry.getTime();
    const diffMs = Math.abs(memberExpiry - accountExpiry);
    const diffDays = diffMs / (24 * 60 * 60 * 1000);

    if (diffDays > 1) {
      // Check if it looks like "now + 30 days" pattern
      const createdAtPlus30 = m.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000;
      const updatedAtPlus30 = m.updatedAt.getTime() + 30 * 24 * 60 * 60 * 1000;
      const joinedAtPlus30 = m.joinedAt ? m.joinedAt.getTime() + 30 * 24 * 60 * 60 * 1000 : 0;
      
      const looksLike30DayReset = 
        Math.abs(memberExpiry - createdAtPlus30) < 2 * 60 * 60 * 1000 || // within 2 hours of createdAt + 30d
        Math.abs(memberExpiry - updatedAtPlus30) < 2 * 60 * 60 * 1000 || // within 2 hours of updatedAt + 30d
        (joinedAtPlus30 && Math.abs(memberExpiry - joinedAtPlus30) < 2 * 60 * 60 * 1000);

      mismatchedMembers.push({
        memberId: m.id,
        email: m.email,
        memberExpiresAt: m.expiresAt?.toISOString(),
        accountSubExpiresAt: accountSubExpiry.toISOString(),
        diffDays: diffDays.toFixed(1),
        groupName: m.familyGroup?.groupName,
        accountEmail: acct?.loginEmail,
        joinedAt: m.joinedAt?.toISOString(),
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
        looksLike30DayReset,
      });
    } else {
      matchedMembers.push({
        email: m.email,
        memberExpiresAt: m.expiresAt?.toISOString(),
        accountSubExpiresAt: accountSubExpiry.toISOString(),
      });
    }
  }

  console.log(`\n=== MEMBERS WITH MATCHING EXPIRY (OK) ===`);
  console.log(`Count: ${matchedMembers.length}`);
  if (matchedMembers.length > 0 && matchedMembers.length <= 20) {
    console.table(matchedMembers);
  }

  console.log(`\n=== MEMBERS WITH MISMATCHED EXPIRY (POTENTIAL BUG) ===`);
  console.log(`Count: ${mismatchedMembers.length}`);
  if (mismatchedMembers.length > 0) {
    console.table(mismatchedMembers.map(m => ({
      email: m.email,
      memberExpiry: m.memberExpiresAt?.slice(0, 10),
      accountExpiry: m.accountSubExpiresAt?.slice(0, 10),
      diffDays: m.diffDays,
      looksLike30DReset: m.looksLike30DayReset ? '✓' : '',
      group: m.groupName,
      acctEmail: m.accountEmail?.slice(0, 20),
    })));
  }

  console.log(`\n=== ACCOUNTS WITHOUT subscriptionExpiresAt ===`);
  console.log(`Count: ${accountNoSubExpiry.length}`);
  if (accountNoSubExpiry.length > 0 && accountNoSubExpiry.length <= 30) {
    console.table(accountNoSubExpiry.map(m => ({
      email: m.email,
      memberExpiry: m.memberExpiresAt?.slice(0, 10),
      group: m.groupName,
      acctEmail: m.accountEmail?.slice(0, 20),
    })));
  }

  // Also check: how many members were manually edited (have audit logs)?
  const manualEdits = await p.auditLog.findMany({
    where: {
      action: { in: ['UPDATE_MEMBER_DATES'] },
      targetType: 'FamilyMember',
    },
    select: { targetId: true, detail: true, createdAt: true }
  });
  
  const manuallyEditedIds = new Set(manualEdits.map(a => a.targetId));
  
  const mismatchedNotManual = mismatchedMembers.filter(m => !manuallyEditedIds.has(m.memberId));
  const mismatchedManual = mismatchedMembers.filter(m => manuallyEditedIds.has(m.memberId));
  
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total mismatched: ${mismatchedMembers.length}`);
  console.log(`  - Manually edited in console (should preserve): ${mismatchedManual.length}`);
  console.log(`  - NOT manually edited (candidates for fix): ${mismatchedNotManual.length}`);
  console.log(`  - Looks like 30-day reset: ${mismatchedMembers.filter(m => m.looksLike30DayReset).length}`);

} finally {
  await p.$disconnect();
}
