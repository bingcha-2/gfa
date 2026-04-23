import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  const email = 'aa01094370039@gmail.com';

  // FamilyMember records
  const members = await p.familyMember.findMany({
    where: { email },
    include: { familyGroup: { select: { groupName: true, status: true, accountId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\n📋 FamilyMember 记录 (${members.length} 条):\n`);
  for (const m of members) {
    console.log(`  组: ${m.familyGroup.groupName} (${m.familyGroup.status}) | 状态: ${m.status}`);
    console.log(`    创建: ${bj(m.createdAt)} | 加入: ${bj(m.joinedAt)} | 移除: ${bj(m.removedAt)}`);
    console.log(`    到期: ${bj(m.expiresAt)} | gaiaId: ${m.googleMemberId || 'N/A'}`);
    console.log(`    displayName: ${m.displayName || 'N/A'}`);
    console.log();
  }

  // Orders
  const orders = await p.order.findMany({
    where: { userEmail: email },
    include: { familyGroup: { select: { groupName: true } }, redeemCode: { select: { code: true, codeType: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`📦 Order (${orders.length} 条):\n`);
  for (const o of orders) {
    console.log(`  ${o.orderNo} | ${o.orderType} | ${o.status} | 组: ${o.familyGroup?.groupName || 'N/A'}`);
    console.log(`    创建: ${bj(o.createdAt)} | 到期: ${bj(o.expiresAt)} | 结果: ${o.resultMessage || 'N/A'}`);
    if (o.redeemCode) console.log(`    兑换码: ${o.redeemCode.code} (${o.redeemCode.codeType})`);
    console.log();
  }

  // Tasks
  const tasks = await p.task.findMany({
    where: { payload: { contains: email } },
    include: {
      familyGroup: { select: { groupName: true } },
      account: { select: { loginEmail: true } },
      logs: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`🔧 Task (${tasks.length} 条):\n`);
  for (const t of tasks) {
    console.log(`  [${bj(t.createdAt)}] ${t.type} | ${t.status} | 来源: ${t.source}`);
    console.log(`    组: ${t.familyGroup?.groupName || 'N/A'} | 主号: ${t.account?.loginEmail || 'N/A'}`);
    if (t.lastErrorCode) console.log(`    ❌ ${t.lastErrorCode}: ${(t.lastErrorMessage || '').slice(0, 150)}`);
    console.log(`    日志 (${t.logs.length} 条):`);
    for (const l of t.logs) {
      console.log(`      [${bj(l.createdAt)}] [${l.level}] ${l.message.slice(0, 250)}`);
    }
    console.log();
  }

  // SwapRecords
  const swaps = await p.swapRecord.findMany({
    where: { OR: [{ oldEmail: email }, { newEmail: email }] },
    include: { order: { select: { orderNo: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`🔄 SwapRecord (${swaps.length} 条):\n`);
  for (const s of swaps) {
    console.log(`  [${bj(s.createdAt)}] ${s.oldEmail} → ${s.newEmail} | 状态: ${s.status} | 订单: ${s.order?.orderNo || 'N/A'}`);
  }

  // Audit logs
  const audits = await p.auditLog.findMany({
    where: { detail: { contains: email } },
    include: { operator: { select: { displayName: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\n📝 审计日志 (${audits.length} 条):\n`);
  for (const a of audits) {
    console.log(`  [${bj(a.createdAt)}] ${a.action} | 操作人: ${a.operator?.displayName || '系统'} (${a.operator?.email || 'N/A'})`);
    console.log(`    ${(a.detail || '').slice(0, 300)}`);
    console.log();
  }
}

main().catch(console.error).finally(() => p.$disconnect());
