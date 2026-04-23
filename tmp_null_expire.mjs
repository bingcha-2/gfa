import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  const accounts = await p.account.findMany({
    where: { subscriptionExpiresAt: null },
    include: {
      familyGroups: {
        select: { groupName: true, status: true, memberCount: true, availableSlots: true },
      },
    },
    orderBy: { loginEmail: 'asc' },
  });

  console.log(`subscriptionExpiresAt 为 null 的账号: ${accounts.length} 个\n`);

  for (const a of accounts) {
    const groups = a.familyGroups.map(g => `${g.groupName}(${g.status},成员${g.memberCount})`).join(', ');
    console.log(`  ${a.loginEmail} | 状态: ${a.status} | 订阅类型: ${a.subscriptionType || 'N/A'} | 组: ${groups || '无'}`);
  }

  // Summary by status
  const byStatus = {};
  for (const a of accounts) {
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  }
  console.log(`\n按状态统计:`);
  for (const [s, c] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${c}`);
  }
}

main().catch(console.error).finally(() => p.$disconnect());
