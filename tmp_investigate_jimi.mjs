import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  const email = 'jimibro666@gmail.com';

  // FamilyMember records
  const members = await p.familyMember.findMany({
    where: { email },
    include: { familyGroup: { select: { groupName: true, accountId: true } } },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n📋 FamilyMember 记录 (${members.length} 条):\n`);
  for (const m of members) {
    console.log(`  组: ${m.familyGroup.groupName} | 状态: ${m.status}`);
    console.log(`    创建: ${bj(m.createdAt)} | 加入: ${bj(m.joinedAt)} | 移除: ${bj(m.removedAt)}`);
    console.log(`    到期: ${bj(m.expiresAt)} | gaiaId: ${m.googleMemberId || 'N/A'}`);
    console.log();
  }

  // Tasks involving this email
  const tasks = await p.task.findMany({
    where: { payload: { contains: email } },
    include: {
      familyGroup: { select: { groupName: true } },
      account: { select: { loginEmail: true } },
      order: { select: { orderNo: true, orderType: true, status: true } },
      logs: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`🔧 涉及的 Task (${tasks.length} 条):\n`);
  for (const t of tasks) {
    const payload = JSON.parse(t.payload || '{}');
    console.log(`  [${bj(t.createdAt)}] ${t.type} | ${t.status} | 来源: ${t.source}`);
    console.log(`    组: ${t.familyGroup?.groupName || 'N/A'} | 主号: ${t.account?.loginEmail || 'N/A'}`);
    console.log(`    Payload: ${JSON.stringify(payload).slice(0, 200)}`);
    if (t.order) console.log(`    订单: ${t.order.orderNo} (${t.order.orderType}, ${t.order.status})`);
    if (t.lastErrorMessage) console.log(`    ❌ 错误: ${t.lastErrorMessage.slice(0, 150)}`);
    console.log(`    日志 (${t.logs.length} 条):`);
    for (const l of t.logs) {
      console.log(`      [${bj(l.createdAt)}] [${l.level}] ${l.message.slice(0, 200)}`);
    }
    console.log();
  }

  // Orders
  const orders = await p.order.findMany({
    where: { userEmail: email },
    include: { familyGroup: { select: { groupName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`📦 Order (${orders.length} 条):\n`);
  for (const o of orders) {
    console.log(`  ${o.orderNo} | ${o.orderType} | ${o.status} | 组: ${o.familyGroup?.groupName || 'N/A'}`);
    console.log(`    创建: ${bj(o.createdAt)} | 结果: ${o.resultMessage || 'N/A'}`);
  }

  // SwapRecords
  const swaps = await p.swapRecord.findMany({
    where: { OR: [{ oldEmail: email }, { newEmail: email }] },
    include: { order: { select: { orderNo: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\n🔄 SwapRecord (${swaps.length} 条):\n`);
  for (const s of swaps) {
    console.log(`  [${bj(s.createdAt)}] ${s.oldEmail} → ${s.newEmail} | 状态: ${s.status} | 订单: ${s.order?.orderNo || 'N/A'}`);
  }
}

main().catch(console.error).finally(() => p.$disconnect());
