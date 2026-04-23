import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  const now = new Date();

  // All SUSPENDED accounts
  const suspended = await p.account.findMany({
    where: { subscriptionStatus: 'SUSPENDED' },
    include: {
      familyGroups: {
        select: { groupName: true, memberCount: true, status: true },
        take: 1,
      },
    },
    orderBy: { subscriptionExpiresAt: 'asc' },
  });

  console.log(`总 SUSPENDED 账号: ${suspended.length}\n`);

  let expiredCount = 0;
  let trulySuspended = 0;
  let noExpiryCount = 0;

  const expiredAccounts = [];
  const trulySuspendedAccounts = [];

  for (const a of suspended) {
    const expiresAt = a.subscriptionExpiresAt;
    const groupInfo = a.familyGroups[0];

    if (!expiresAt) {
      noExpiryCount++;
    } else if (expiresAt <= now) {
      expiredCount++;
      expiredAccounts.push(a);
    } else {
      trulySuspended++;
      trulySuspendedAccounts.push(a);
    }
  }

  console.log(`${'='.repeat(60)}`);
  console.log(`  分类统计:`);
  console.log(`    ❌ 已过期 (subscriptionExpiresAt <= now): ${expiredCount}`);
  console.log(`    ⚠️ 真正暂停 (subscriptionExpiresAt > now): ${trulySuspended}`);
  console.log(`    ❓ 无到期时间 (null): ${noExpiryCount}`);
  console.log(`${'='.repeat(60)}\n`);

  if (expiredAccounts.length > 0) {
    console.log(`\n❌ 应显示为「已过期」而非「已暂停」的账号 (${expiredAccounts.length} 个):\n`);
    for (const a of expiredAccounts) {
      const group = a.familyGroups[0];
      console.log(`  ${a.loginEmail}`);
      console.log(`    到期: ${bj(a.subscriptionExpiresAt)} | 暂停时间: ${bj(a.subscriptionStatusUpdatedAt)}`);
      console.log(`    组: ${group?.groupName || 'N/A'} (${group?.status}, 成员${group?.memberCount})`);

      // Check if any active members with expiresAt in future
      const activeMembers = await p.familyMember.findMany({
        where: {
          familyGroup: { accountId: a.id },
          status: { in: ['ACTIVE', 'PENDING'] },
          expiresAt: { gt: now },
        },
        select: { email: true, expiresAt: true },
      });

      if (activeMembers.length > 0) {
        console.log(`    ⚠️ 有 ${activeMembers.length} 个成员到期时间未到 (应允许自助售后):`);
        for (const m of activeMembers) {
          console.log(`      ${m.email} → 到期: ${bj(m.expiresAt)}`);
        }
      }
      console.log();
    }
  }

  if (trulySuspendedAccounts.length > 0) {
    console.log(`\n⚠️ 真正暂停 (订阅在有效期内但被暂停):\n`);
    for (const a of trulySuspendedAccounts) {
      const group = a.familyGroups[0];
      console.log(`  ${a.loginEmail}`);
      console.log(`    到期: ${bj(a.subscriptionExpiresAt)} | 暂停时间: ${bj(a.subscriptionStatusUpdatedAt)}`);
      console.log(`    组: ${group?.groupName || 'N/A'} (${group?.status}, 成员${group?.memberCount})`);
    }
  }
}

main().catch(console.error).finally(() => p.$disconnect());
