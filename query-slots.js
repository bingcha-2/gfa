const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const groupId = 'cmofe28j600t4xkhgf5b2y8o7';
  const accountId = 'cmofe28j100t2xkhggwx1vrr8';
  
  // Find ALL orders assigned to this account (not just group)
  const accountOrders = await p.order.findMany({
    where: { 
      OR: [
        { familyGroupId: groupId },
        // Check if any orders reference this account's tasks
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  console.log(`Orders for group: ${accountOrders.length}`);

  // Find ALL tasks for this group, including ones that might have changed group
  const allTasks = await p.task.findMany({
    where: { familyGroupId: groupId },
    orderBy: { createdAt: 'asc' }
  });
  console.log(`\nAll tasks for group (${allTasks.length}):`);
  for (const t of allTasks) {
    const payload = JSON.parse(t.payload || '{}');
    console.log(`  [${t.createdAt.toISOString()}] ${t.type} | ${t.status} | orderId: ${t.orderId || '-'}`);
    console.log(`    user: ${payload.userEmail || payload.memberEmail || '-'} | updated: ${t.updatedAt.toISOString()}`);
  }

  // Check if there are pending orders assigned to this group that we missed
  const pendingOrders = await p.order.findMany({
    where: {
      status: { in: ['GROUP_ASSIGNED', 'TASK_QUEUED', 'PROCESSING'] },
      familyGroupId: groupId
    }
  });
  console.log(`\nPending orders for this group: ${pendingOrders.length}`);
  for (const o of pendingOrders) {
    console.log(`  ${o.orderNo} | ${o.status} | ${o.userEmail}`);
  }

  // Check FamilyMember records with PENDING status
  const pendingMembers = await p.familyMember.findMany({
    where: { familyGroupId: groupId, status: 'PENDING' }
  });
  console.log(`\nPENDING members: ${pendingMembers.length}`);
  for (const m of pendingMembers) {
    console.log(`  ${m.email} | created: ${m.createdAt.toISOString()}`);
  }

  // Check invite tasks specifically that are NOT terminal
  const pendingInviteTasks = await p.task.findMany({
    where: { 
      familyGroupId: groupId,
      type: 'INVITE_MEMBER',
      status: { notIn: ['SUCCESS', 'FAILED_FINAL', 'CANCELLED'] }
    }
  });
  console.log(`\nNon-terminal INVITE tasks: ${pendingInviteTasks.length}`);
  for (const t of pendingInviteTasks) {
    const payload = JSON.parse(t.payload || '{}');
    console.log(`  [${t.createdAt.toISOString()}] ${t.status} | user: ${payload.userEmail} | orderId: ${t.orderId || '-'}`);
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
