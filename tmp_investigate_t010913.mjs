import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = 't01091395490@gmail.com';
  const emailLower = email.toLowerCase();

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  完整调查: ${email}`);
  console.log(`${'='.repeat(70)}\n`);

  // 1. FamilyMember records
  const members = await prisma.familyMember.findMany({
    where: { email: { contains: 't01091395490' } },
    include: { familyGroup: { include: { account: { select: { loginEmail: true, name: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`📋 FamilyMember 记录 (${members.length} 条):`);
  for (const m of members) {
    console.log(`  组: ${m.familyGroup.groupName} (主号: ${m.familyGroup.account.loginEmail})`);
    console.log(`    状态: ${m.status} | 角色: ${m.role} | canAutoRemove: ${m.canAutoRemove}`);
    console.log(`    加入: ${m.joinedAt?.toISOString() || 'N/A'} | 移除: ${m.removedAt?.toISOString() || 'N/A'}`);
    console.log(`    过期: ${m.expiresAt?.toISOString() || '永久'}`);
    console.log(`    gaiaId: ${m.googleMemberId || 'N/A'}`);
    console.log(`    创建: ${m.createdAt.toISOString()} | 更新: ${m.updatedAt.toISOString()}`);
    console.log();
  }

  // 2. FamilyInvite records
  const invites = await prisma.familyInvite.findMany({
    where: { email: { contains: 't01091395490' } },
    include: { familyGroup: { include: { account: { select: { loginEmail: true } } } } },
    orderBy: { sentAt: 'asc' },
  });
  console.log(`📨 FamilyInvite 记录 (${invites.length} 条):`);
  for (const inv of invites) {
    console.log(`  组: ${inv.familyGroup.groupName} (主号: ${inv.familyGroup.account.loginEmail})`);
    console.log(`    状态: ${inv.status} | 发送: ${inv.sentAt.toISOString()} | 过期: ${inv.expiresAt?.toISOString() || 'N/A'}`);
    console.log();
  }

  // 3. Tasks with this email in payload
  const allTasks = await prisma.task.findMany({
    where: { payload: { contains: 't01091395490' } },
    include: {
      familyGroup: { select: { groupName: true } },
      account: { select: { loginEmail: true } },
      order: { select: { orderNo: true, orderType: true, status: true, userEmail: true } },
      logs: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`🔧 Task 记录 (${allTasks.length} 条):`);
  for (const t of allTasks) {
    const bjTime = new Date(t.createdAt.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`  --- Task ${t.id} ---`);
    console.log(`    类型: ${t.type} | 状态: ${t.status} | 来源: ${t.source}`);
    console.log(`    时间(北京): ${bjTime}`);
    console.log(`    组: ${t.familyGroup?.groupName || 'N/A'} | 主号: ${t.account?.loginEmail || 'N/A'}`);
    console.log(`    订单: ${t.order ? `${t.order.orderNo} (${t.order.orderType}, ${t.order.status})` : '无'}`);
    const payload = JSON.parse(t.payload || '{}');
    console.log(`    Payload: ${JSON.stringify(payload, null, 2).split('\n').join('\n    ')}`);
    if (t.lastErrorMessage) console.log(`    ❌ 错误: ${t.lastErrorMessage}`);
    if (t.finishedAt) {
      const finBj = new Date(t.finishedAt.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
      console.log(`    完成: ${finBj}`);
    }
    if (t.logs.length > 0) {
      console.log(`    日志 (${t.logs.length} 条):`);
      for (const l of t.logs) {
        const logBj = new Date(l.createdAt.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
        console.log(`      [${logBj}] [${l.level}] ${l.message}`);
      }
    }
    console.log();
  }

  // 4. Orders with this email
  const orders = await prisma.order.findMany({
    where: { userEmail: { contains: 't01091395490' } },
    include: {
      familyGroup: { select: { groupName: true } },
      tasks: { select: { id: true, type: true, status: true } },
      redeemCode: { select: { code: true, codeType: true, status: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`📦 Order 记录 (${orders.length} 条):`);
  for (const o of orders) {
    const bjTime = new Date(o.createdAt.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`  订单号: ${o.orderNo}`);
    console.log(`    类型: ${o.orderType} | 状态: ${o.status} | 时间: ${bjTime}`);
    console.log(`    组: ${o.familyGroup?.groupName || 'N/A'}`);
    console.log(`    兑换码: ${o.redeemCode ? `${o.redeemCode.code} (${o.redeemCode.codeType}, ${o.redeemCode.status})` : '无'}`);
    console.log(`    结果: ${o.resultMessage || 'N/A'}`);
    console.log(`    关联任务: ${o.tasks.map(t => `${t.id.slice(0,12)}(${t.type}:${t.status})`).join(', ') || '无'}`);
    console.log();
  }

  // 5. SwapRecords
  const swaps = await prisma.swapRecord.findMany({
    where: { OR: [{ oldEmail: { contains: 't01091395490' } }, { newEmail: { contains: 't01091395490' } }] },
    include: { order: { select: { orderNo: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`🔄 SwapRecord 记录 (${swaps.length} 条):`);
  for (const s of swaps) {
    console.log(`  订单: ${s.order?.orderNo || 'N/A'} | ${s.oldEmail} → ${s.newEmail} | 状态: ${s.status}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
