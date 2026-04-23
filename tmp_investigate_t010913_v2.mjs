import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = 't01091395490@gmail.com';

  // Find all INVITE_MEMBER tasks for this email — these are the ones that put it INTO a group
  const inviteTasks = await prisma.task.findMany({
    where: {
      type: 'INVITE_MEMBER',
      payload: { contains: 't01091395490' },
    },
    include: {
      familyGroup: { select: { groupName: true, accountId: true } },
      account: { select: { loginEmail: true } },
      order: { select: { orderNo: true, orderType: true, status: true, userEmail: true, familyGroupId: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n📨 把 ${email} 邀请进组的 INVITE_MEMBER 任务 (${inviteTasks.length} 条):\n`);
  for (const t of inviteTasks) {
    const bjTime = new Date(t.createdAt.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    const payload = JSON.parse(t.payload || '{}');
    console.log(`  Task: ${t.id}`);
    console.log(`    时间: ${bjTime} | 状态: ${t.status} | 来源: ${t.source}`);
    console.log(`    目标组: ${t.familyGroup?.groupName || 'N/A'} | 主号: ${t.account?.loginEmail || 'N/A'}`);
    console.log(`    订单: ${t.order ? `${t.order.orderNo} (type=${t.order.orderType}, status=${t.order.status}, user=${t.order.userEmail})` : '❌ 无订单 (控制台手动邀请)'}`);
    console.log(`    payload.userEmail: ${payload.userEmail}`);
    console.log();
  }

  // Find all REPLACE_MEMBER tasks involving this email
  const replaceTasks = await prisma.task.findMany({
    where: {
      type: 'REPLACE_MEMBER',
      payload: { contains: 't01091395490' },
    },
    include: {
      familyGroup: { select: { groupName: true } },
      account: { select: { loginEmail: true } },
      order: { select: { orderNo: true, orderType: true, status: true, userEmail: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n🔄 涉及 ${email} 的 REPLACE_MEMBER 任务 (${replaceTasks.length} 条):\n`);
  for (const t of replaceTasks) {
    const bjTime = new Date(t.createdAt.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    const payload = JSON.parse(t.payload || '{}');
    console.log(`  Task: ${t.id}`);
    console.log(`    时间: ${bjTime} | 状态: ${t.status}`);
    console.log(`    组: ${t.familyGroup?.groupName || 'N/A'} | 主号: ${t.account?.loginEmail || 'N/A'}`);
    console.log(`    操作: ${payload.targetMemberEmail} → ${payload.newUserEmail}`);
    console.log(`    订单: ${t.order ? `${t.order.orderNo} (${t.order.orderType})` : '无'}`);
    console.log();
  }

  // Check: which group did the SabbGreenburg invite come from?
  console.log(`\n${'='.repeat(60)}`);
  console.log(`关键问题: t01091395490 是怎么进入 SabbGreenburg 组的?`);
  console.log(`${'='.repeat(60)}\n`);

  // Find the specific FamilyMember record in SabbGreenburg
  const sabbMember = await prisma.familyMember.findFirst({
    where: {
      email: { contains: 't01091395490' },
      familyGroup: { groupName: 'SabbGreenburg' },
    },
    include: { familyGroup: true },
  });
  if (sabbMember) {
    console.log(`  SabbGreenburg 组中的记录:`);
    console.log(`    创建时间: ${sabbMember.createdAt.toISOString()}`);
    console.log(`    joinedAt: ${sabbMember.joinedAt?.toISOString() || 'N/A'}`);
    console.log(`    removedAt: ${sabbMember.removedAt?.toISOString() || 'N/A'}`);
    console.log(`    状态: ${sabbMember.status}`);
    console.log(`    gaiaId: ${sabbMember.googleMemberId}`);

    // Find any task that could have created this record (around the creation time)
    const nearbyTasks = await prisma.task.findMany({
      where: {
        familyGroupId: sabbMember.familyGroupId,
        payload: { contains: 't01091395490' },
      },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`\n  该组中涉及此邮箱的所有任务:`);
    for (const t of nearbyTasks) {
      const bjTime = new Date(t.createdAt.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
      const payload = JSON.parse(t.payload || '{}');
      console.log(`    [${bjTime}] ${t.type} | ${t.status} | ${t.source} | ${payload.targetMemberEmail || ''} → ${payload.newUserEmail || payload.userEmail || ''}`);
      if (t.orderId) {
        const order = await prisma.order.findUnique({ where: { id: t.orderId }, select: { orderNo: true, orderType: true } });
        console.log(`      订单: ${order?.orderNo} (${order?.orderType})`);
      } else {
        console.log(`      ❌ 无订单`);
      }
    }
  }

  // Also check SYNC tasks that might have discovered this member
  const syncTasks = await prisma.task.findMany({
    where: {
      type: 'SYNC_FAMILY_GROUP',
      familyGroupId: sabbMember?.familyGroupId,
      createdAt: {
        gte: new Date('2026-04-02T19:00:00Z'),
        lte: new Date('2026-04-02T22:00:00Z'),
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (syncTasks.length > 0) {
    console.log(`\n  SabbGreenburg 组在 4/2 19:00-22:00 UTC 的同步任务:`);
    for (const t of syncTasks) {
      console.log(`    [${t.createdAt.toISOString()}] ${t.status}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
