import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const targetEmail = 'SoaresIsa258@gmail.com';
  const targetEmailLower = targetEmail.toLowerCase();

  // 1. Find the account
  const allAccounts = await prisma.account.findMany({ include: { familyGroups: true } });
  const account = allAccounts.find(a => a.loginEmail.toLowerCase() === targetEmailLower);

  if (!account) {
    console.log(`❌ Account ${targetEmail} not found.`);
    return;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  主号: ${account.loginEmail}`);
  console.log(`  Name: ${account.name} | Status: ${account.status}`);
  console.log(`  订阅: ${account.subscriptionPlan || 'N/A'} | 到期: ${account.subscriptionExpiresAt?.toISOString() || 'N/A'}`);
  console.log(`  家庭组: ${account.familyGroups.map(g => g.groupName).join(', ')}`);
  console.log(`${'='.repeat(60)}\n`);

  const familyGroupIds = account.familyGroups.map(g => g.id);

  // 2. Recent INVITE_MEMBER tasks (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const inviteTasks = await prisma.task.findMany({
    where: {
      type: 'INVITE_MEMBER',
      OR: [
        { accountId: account.id },
        { familyGroupId: { in: familyGroupIds } },
      ],
      createdAt: { gte: thirtyDaysAgo },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      familyGroup: { select: { groupName: true } },
      order: { select: { orderNo: true, userEmail: true, orderType: true } },
      logs: { orderBy: { createdAt: 'desc' }, take: 2 },
    },
  });

  console.log(`📨 近30天邀请任务 (共 ${inviteTasks.length} 条)\n`);
  console.log('# | 时间(北京) | 状态 | 邀请邮箱 | 目标组 | 来源 | 订单号');
  console.log('--|-----------|------|---------|-------|------|------');

  for (let i = 0; i < inviteTasks.length; i++) {
    const t = inviteTasks[i];
    const payload = JSON.parse(t.payload || '{}');
    const bjTime = new Date(t.createdAt.getTime() + 8 * 3600000);
    const timeStr = bjTime.toISOString().replace('T', ' ').slice(0, 19);
    const userEmail = payload.userEmail || t.order?.userEmail || '';
    const groupName = t.familyGroup?.groupName || '';
    const source = t.source || '';
    const orderNo = t.order?.orderNo || '(控制台)';
    console.log(`${i + 1} | ${timeStr} | ${t.status} | ${userEmail} | ${groupName} | ${source} | ${orderNo}`);
  }

  // 3. FamilyInvite records
  const invites = await prisma.familyInvite.findMany({
    where: {
      familyGroupId: { in: familyGroupIds },
      createdAt: { gte: thirtyDaysAgo },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      familyGroup: { select: { groupName: true } },
    },
  });

  console.log(`\n\n📋 近30天 FamilyInvite 记录 (共 ${invites.length} 条)\n`);
  console.log('# | 发送时间(北京) | 状态 | 邮箱 | 组名 | 过期时间');
  console.log('--|-------------|------|------|------|-------');
  for (let i = 0; i < invites.length; i++) {
    const inv = invites[i];
    const bjTime = new Date(inv.sentAt.getTime() + 8 * 3600000);
    const timeStr = bjTime.toISOString().replace('T', ' ').slice(0, 19);
    const expiresStr = inv.expiresAt ? new Date(inv.expiresAt.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';
    console.log(`${i + 1} | ${timeStr} | ${inv.status} | ${inv.email} | ${inv.familyGroup?.groupName || ''} | ${expiresStr}`);
  }

  // 4. Current family members
  for (const group of account.familyGroups) {
    const members = await prisma.familyMember.findMany({
      where: { familyGroupId: group.id },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`\n\n👥 ${group.groupName} 当前成员 (${members.length}/${group.maxMembers}, 可用: ${group.availableSlots}, 待邀: ${group.pendingInviteCount})`);
    console.log('# | 邮箱 | 角色 | 状态 | 到期时间 | 加入时间');
    console.log('--|------|------|------|---------|-------');
    members.forEach((m, i) => {
      const joinStr = m.joinedAt ? new Date(m.joinedAt.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';
      const expStr = m.expiresAt ? new Date(m.expiresAt.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : '永久';
      console.log(`${i+1} | ${m.email} | ${m.role} | ${m.status} | ${expStr} | ${joinStr}`);
    });
  }

  // 5. Recent orders tied to this group
  const orders = await prisma.order.findMany({
    where: {
      familyGroupId: { in: familyGroupIds },
      createdAt: { gte: thirtyDaysAgo },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  console.log(`\n\n📦 近30天关联订单 (共 ${orders.length} 条)\n`);
  console.log('# | 订单号 | 类型 | 状态 | 用户邮箱 | 创建时间(北京)');
  console.log('--|--------|------|------|---------|-------------');
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const bjTime = new Date(o.createdAt.getTime() + 8*3600000);
    const timeStr = bjTime.toISOString().replace('T',' ').slice(0,19);
    console.log(`${i+1} | ${o.orderNo} | ${o.orderType} | ${o.status} | ${o.userEmail} | ${timeStr}`);
  }

  console.log('\n');
}

main().catch(console.error).finally(() => prisma.$disconnect());
