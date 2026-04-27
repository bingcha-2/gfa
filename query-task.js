const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const email = 'archzk.49@gmail.com';
  
  // Check as member
  const members = await p.familyMember.findMany({
    where: { email: { contains: 'archzk', mode: undefined } },
    include: { familyGroup: { select: { id: true, groupName: true, status: true, account: { select: { loginEmail: true } } } } },
  });
  console.log(`=== 成员记录 (${members.length}) ===`);
  for (const m of members) {
    console.log(`  ${m.email} | ${m.status} | 组: ${m.familyGroup.groupName} (${m.familyGroup.account?.loginEmail}) | 组状态: ${m.familyGroup.status}`);
    console.log(`  到期: ${m.expiresAt?.toISOString()?.substring(0,16) ?? '—'} | 加入: ${m.joinedAt?.toISOString()?.substring(0,16) ?? '—'} | 移除: ${m.removedAt?.toISOString()?.substring(0,16) ?? '—'}`);
  }

  // Check as order
  const orders = await p.order.findMany({
    where: { userEmail: { contains: 'archzk' } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log(`\n=== 订单 (${orders.length}) ===`);
  for (const o of orders) {
    console.log(`  ${o.orderNo} | ${o.orderType} | ${o.status} | groupId: ${o.familyGroupId ?? '—'} | created: ${o.createdAt.toISOString().substring(0,16)}`);
  }

  // Check as account (parent)
  const account = await p.account.findUnique({ where: { loginEmail: email } });
  if (account) {
    console.log(`\n=== 作为母号 ===`);
    console.log(`  状态: ${account.status} | syncError: ${account.syncError ?? '—'}`);
  } else {
    console.log(`\n不是母号`);
  }

  // Check in tasks
  const tasks = await p.$queryRawUnsafe(
    `SELECT t.id, t.type, t.status, t."lastErrorCode", t.payload, t."createdAt"
     FROM "Task" t WHERE t.payload LIKE '%archzk%'
     ORDER BY t."createdAt" DESC LIMIT 5`
  );
  console.log(`\n=== 相关任务 (${tasks.length}) ===`);
  for (const t of tasks) {
    console.log(`  [${new Date(t.createdAt).toISOString().substring(0,19)}] ${t.type} | ${t.status} | ${t.lastErrorCode || '—'}`);
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
