import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const accountEmail = 'HaldimanHeilman@gmail.com';
  
  // 1. Find the Account
  // Try exact match first, then case-insensitive
  let account = await prisma.account.findUnique({
    where: { loginEmail: accountEmail },
    include: { familyGroups: true }
  });

  if (!account) {
    account = await prisma.account.findFirst({
      where: { loginEmail: accountEmail },
      include: { familyGroups: true }
    });
  }

  if (!account) {
    console.log(`Account not found for email: ${accountEmail}`);
    
    // Also try checking broadly
    const accounts = await prisma.account.findMany({
      where: { loginEmail: { contains: 'Haldiman', mode: 'insensitive' } },
      include: { familyGroups: true }
    });
    if (accounts.length > 0) {
      console.log('Did you mean:');
      for (const a of accounts) {
        console.log(` - ${a.loginEmail}`);
      }
    }
    return;
  }

  console.log('=== ACCOUNT INFO ===');
  console.log(`ID: ${account.id}`);
  console.log(`Email: ${account.loginEmail}`);
  console.log(`Status: ${account.status}`);
  console.log(`Sync Error: ${account.syncError}`);
  console.log(`Subscription Status: ${account.subscriptionStatus}`);
  console.log(`Subscription Expires At: ${account.subscriptionExpiresAt}`);
  console.log(`Subscription Updated At: ${account.subscriptionStatusUpdatedAt}`);
  console.log(`Updated At: ${account.updatedAt}`);

  for (const group of account.familyGroups) {
    console.log(`\n=== FAMILY GROUP: ${group.groupName} (${group.id}) ===`);
    console.log(`Status: ${group.status}`);
    console.log(`Member Count: ${group.memberCount} / Available Slots: ${group.availableSlots}`);
    console.log(`Updated At: ${group.updatedAt}`);
  }

  console.log('\n=== RECENT TASKS ===');
  const tasks = await prisma.task.findMany({
    where: { accountId: account.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      logs: { orderBy: { createdAt: 'desc' }, take: 5 }
    }
  });

  for (const t of tasks) {
    console.log(`\nTask ID: ${t.id} | Type: ${t.type} | Status: ${t.status}`);
    console.log(`Started: ${t.startedAt} | Finished: ${t.finishedAt}`);
    console.log(`Error: ${t.lastErrorCode} - ${t.lastErrorMessage}`);
    for (const l of t.logs) {
      console.log(`  [${l.createdAt.toISOString()}] [${l.level}] ${l.message}`);
    }
  }

  console.log('\n=== AUDIT LOGS ===');
  const auditLogs = await prisma.auditLog.findMany({
    where: { 
      OR: [
        { targetId: account.id, targetType: 'ACCOUNT' },
        ...account.familyGroups.map(g => ({ targetId: g.id, targetType: 'FAMILY_GROUP' }))
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  if (auditLogs.length === 0) {
    console.log('No recent audit logs found.');
  }

  for (const l of auditLogs) {
    console.log(`[${l.createdAt.toISOString()}] ${l.action} (${l.targetType}:${l.targetId}) - ${l.detail}`);
  }
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
