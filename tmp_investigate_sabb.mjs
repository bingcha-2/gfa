import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const groupName = 'SabbGreenburg';
  
  // Find the group
  const group = await prisma.familyGroup.findFirst({
    where: { groupName },
    include: { account: { select: { loginEmail: true } } },
  });
  if (!group) { console.log('Group not found'); return; }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  SabbGreenburg 组完整调查`);
  console.log(`  主号: ${group.account.loginEmail}`);
  console.log(`  状态: ${group.status} | maxMembers: ${group.maxMembers}`);
  console.log(`  memberCount: ${group.memberCount} | availableSlots: ${group.availableSlots}`);
  console.log(`  pendingInviteCount: ${group.pendingInviteCount}`);
  console.log(`${'='.repeat(70)}\n`);

  // All members ever
  const allMembers = await prisma.familyMember.findMany({
    where: { familyGroupId: group.id },
    orderBy: { createdAt: 'asc' },
  });
  
  const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

  console.log(`📋 全部 FamilyMember (${allMembers.length} 条):\n`);
  for (const m of allMembers) {
    console.log(`  ${m.email}`);
    console.log(`    状态: ${m.status} | 创建: ${bj(m.createdAt)} | 加入: ${bj(m.joinedAt)} | 移除: ${bj(m.removedAt)}`);
    console.log(`    过期: ${bj(m.expiresAt)} | gaiaId: ${m.googleMemberId || 'N/A'}`);
    console.log();
  }

  // All tasks in this group, sorted by time
  const tasks = await prisma.task.findMany({
    where: { familyGroupId: group.id },
    include: {
      order: { select: { orderNo: true, orderType: true, status: true, userEmail: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n🔧 全部 Task (${tasks.length} 条):\n`);
  for (const t of tasks) {
    const payload = JSON.parse(t.payload || '{}');
    const userEmail = payload.userEmail || payload.newUserEmail || payload.targetMemberEmail || '';
    const action = t.type === 'REPLACE_MEMBER' 
      ? `${payload.targetMemberEmail} → ${payload.newUserEmail}`
      : t.type === 'INVITE_MEMBER' ? `邀请 ${payload.userEmail}`
      : t.type === 'REMOVE_MEMBER' ? `移除 ${payload.memberEmail || payload.targetMemberEmail || '?'}`
      : t.type;
    
    console.log(`  [${bj(t.createdAt)}] ${t.type} | ${t.status} | 来源: ${t.source}`);
    console.log(`    操作: ${action}`);
    if (t.order) {
      console.log(`    订单: ${t.order.orderNo} (${t.order.orderType}, 状态=${t.order.status}, user=${t.order.userEmail})`);
    }
    if (t.lastErrorCode || t.lastErrorMessage) {
      console.log(`    ❌ 错误: [${t.lastErrorCode}] ${(t.lastErrorMessage || '').slice(0, 150)}`);
    }
    if (t.finishedAt) {
      console.log(`    开始: ${bj(t.startedAt)} | 完成: ${bj(t.finishedAt)}`);
    }
    console.log();
  }

  // All orders linked to this group
  const orders = await prisma.order.findMany({
    where: { familyGroupId: group.id },
    include: {
      redeemCode: { select: { code: true, codeType: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n📦 全部 Order (${orders.length} 条):\n`);
  for (const o of orders) {
    console.log(`  ${o.orderNo} | ${o.orderType} | 状态: ${o.status}`);
    console.log(`    用户: ${o.userEmail} | 创建: ${bj(o.createdAt)}`);
    console.log(`    兑换码: ${o.redeemCode ? `${o.redeemCode.code} (${o.redeemCode.codeType})` : '无'}`);
    console.log(`    结果: ${o.resultMessage || 'N/A'}`);
    console.log();
  }

  // FamilyInvite records
  const invites = await prisma.familyInvite.findMany({
    where: { familyGroupId: group.id },
    orderBy: { sentAt: 'asc' },
  });
  console.log(`\n📨 FamilyInvite (${invites.length} 条):\n`);
  for (const inv of invites) {
    console.log(`  ${inv.email} | 状态: ${inv.status} | 发送: ${bj(inv.sentAt)}`);
  }

  // SwapRecords related to this group's orders
  const orderIds = orders.map(o => o.id);
  if (orderIds.length > 0) {
    const swaps = await prisma.swapRecord.findMany({
      where: { orderId: { in: orderIds } },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`\n🔄 SwapRecord (${swaps.length} 条):\n`);
    for (const s of swaps) {
      const order = orders.find(o => o.id === s.orderId);
      console.log(`  [${bj(s.createdAt)}] ${order?.orderNo || '?'} | ${s.oldEmail} → ${s.newEmail} | 状态: ${s.status}`);
    }
  }

  // Current non-removed members summary
  const current = allMembers.filter(m => m.status !== 'REMOVED');
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  当前有效成员 (非REMOVED): ${current.length} 个`);
  for (const m of current) {
    console.log(`    ${m.email} (${m.status})`);
  }
  console.log(`  数据库 memberCount=${group.memberCount}, availableSlots=${group.availableSlots}`);
  console.log(`${'='.repeat(70)}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
