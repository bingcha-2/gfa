import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Get the family group and its orders
  const groupId = 'cmn9zv24r008exkosfi1s86xy';
  const accountId = 'cmn9zv24i008cxkosesbou1wa';

  const group = await prisma.familyGroup.findUnique({
    where: { id: groupId },
    include: {
      account: { select: { id: true, name: true, loginEmail: true, status: true } },
      members: { orderBy: { createdAt: 'desc' } },
      orders: { orderBy: { createdAt: 'desc' }, take: 10 }
    }
  });

  if (!group) {
    console.log('Family group not found');
    return;
  }

  console.log('=== FAMILY GROUP ===');
  console.log('ID:', group.id);
  console.log('Group Name:', group.groupName);
  console.log('Status:', group.status);
  console.log('Member Count:', group.memberCount);
  console.log('Available Slots:', group.availableSlots);
  console.log('Pending Invite Count:', group.pendingInviteCount);
  console.log('Last Synced:', group.lastSyncedAt);

  console.log('\n=== ACCOUNT ===');
  if (group.account) {
    console.log('ID:', group.account.id);
    console.log('Name:', group.account.name);
    console.log('Email:', group.account.loginEmail);
    console.log('Status:', group.account.status);
  }

  console.log('\n=== MEMBERS (' + group.members.length + ') ===');
  for (const m of group.members) {
    console.log(`  ${m.email} | ${m.status} | ${m.role} | Joined: ${m.joinedAt} | Expires: ${m.expiresAt} | ID: ${m.id}`);
  }

  console.log('\n=== RECENT ORDERS (' + group.orders.length + ') ===');
  for (const o of group.orders) {
    console.log(`  ${o.id} | ${o.orderNo} | ${o.orderType} | ${o.status} | ${o.userEmail} | Created: ${o.createdAt}`);
  }

  // Also get recent sync tasks for this group
  const syncTasks = await prisma.task.findMany({
    where: { familyGroupId: groupId, type: 'SYNC_FAMILY_GROUP' },
    orderBy: { createdAt: 'desc' },
    take: 5
  });

  console.log('\n=== RECENT SYNC TASKS (' + syncTasks.length + ') ===');
  for (const t of syncTasks) {
    console.log(`  ${t.id} | ${t.status} | Started: ${t.startedAt} | Finished: ${t.finishedAt} | Created: ${t.createdAt}`);
    if (t.lastErrorMessage) console.log(`    Error: ${t.lastErrorMessage}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
