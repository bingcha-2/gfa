const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const accountEmail = 'bernardteofano@gmail.com';

  const account = await p.account.findUnique({
    where: { loginEmail: accountEmail }
  });
  
  if (!account) {
    console.log('Account not found');
    process.exit(0);
  }

  console.log(`=== 母号信息 ===`);
  console.log(`ID: ${account.id}`);
  console.log(`Email: ${account.loginEmail}`);
  console.log(`Status: ${account.status}`);
  console.log(`Created At: ${account.createdAt.toISOString()}`);
  
  const group = await p.familyGroup.findFirst({
    where: { accountId: account.id },
    include: {
      members: true
    }
  });

  if (group) {
    console.log(`\n=== 家庭组 ===`);
    console.log(`Group ID: ${group.id}`);
    console.log(`Name: ${group.groupName}`);
    console.log(`Status: ${group.status}`);
    console.log(`Last Synced: ${group.lastSyncedAt ? group.lastSyncedAt.toISOString() : 'Never'}`);
    console.log(`Member Count: ${group.memberCount} / Slots: ${group.availableSlots}`);
    
    console.log(`\n=== 成员 (${group.members.length}) ===`);
    for (const m of group.members) {
      console.log(`  ${m.email} | Status: ${m.status} | Role: ${m.role}`);
      console.log(`    Joined: ${m.joinedAt ? m.joinedAt.toISOString() : '-'} | Expires: ${m.expiresAt ? m.expiresAt.toISOString() : '-'}`);
      console.log(`    Created: ${m.createdAt.toISOString()} | Removed: ${m.removedAt ? m.removedAt.toISOString() : '-'}`);
    }
  }

  const tasks = await p.task.findMany({
    where: { accountId: account.id },
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  console.log(`\n=== 最近任务 (${tasks.length}) ===`);
  for (const t of tasks) {
    console.log(`  [${t.createdAt.toISOString()}] ${t.type} | ${t.status} | ${t.lastErrorCode || '-'}`);
    console.log(`  Payload: ${t.payload}`);
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
