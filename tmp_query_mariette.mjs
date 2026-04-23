import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const accountEmail = 'MarietteDimas@gmail.com';
  
  const account = await prisma.account.findUnique({
    where: { loginEmail: accountEmail },
    include: { familyGroups: true }
  });

  if (!account) {
    console.log(`Account ${accountEmail} not found`);
    return;
  }

  console.log('=== ACCOUNT INFO ===');
  console.log(`ID: ${account.id}`);
  console.log(`Email: ${account.loginEmail}`);
  console.log(`Status: ${account.status}`);
  console.log(`Sync Error: ${account.syncError}`);
  console.log(`Subscription Status: ${account.subscriptionStatus}`);
  console.log(`Subscription Updated At: ${account.subscriptionStatusUpdatedAt}`);
  console.log(`Updated At: ${account.updatedAt}`);

  for (const group of account.familyGroups) {
    console.log(`\n=== FAMILY GROUP: ${group.groupName} (${group.id}) ===`);
    console.log(`Status: ${group.status}`);
    console.log(`Member Count: ${group.memberCount} / Available Slots: ${group.availableSlots}`);
    console.log(`Updated At: ${group.updatedAt}`);
  }

  console.log('\n=== HUNTING FOR MANUAL_ONLY CAUSE ===');
  
  // 1. Check all TaskLogs for this account
  const accountTasks = await prisma.task.findMany({
    where: { accountId: account.id },
    select: { id: true, type: true, status: true, createdAt: true }
  });
  
  const taskIds = accountTasks.map(t => t.id);
  
  console.log(`Found ${taskIds.length} tasks for this account.`);

  const relevantLogs = await prisma.taskLog.findMany({
    where: {
      taskId: { in: taskIds },
      message: { contains: 'MANUAL_ONLY' }
    },
    orderBy: { createdAt: 'desc' },
    include: { task: true }
  });
  
  for (const log of relevantLogs) {
    console.log(`[TaskLog] [${log.createdAt.toISOString()}] [Task: ${log.taskId}] (${log.task.type}): ${log.message}`);
  }

  const suspendedLogs = await prisma.taskLog.findMany({
    where: {
      taskId: { in: taskIds },
      message: { contains: 'SUSPENDED' }
    },
    orderBy: { createdAt: 'desc' },
    include: { task: true }
  });

  for (const log of suspendedLogs) {
    console.log(`[TaskLog] [${log.createdAt.toISOString()}] [Task: ${log.taskId}] (${log.task.type}) [SUSPENDED]: ${log.message}`);
  }

  // 2. Check all AuditLogs globally just in case targetType/Id mismatched
  const globalAudit = await prisma.auditLog.findMany({
    where: {
      OR: [
        { detail: { contains: account.id } },
        ...account.familyGroups.map(g => ({ detail: { contains: g.id } })),
        { detail: { contains: 'MANUAL_ONLY' }, targetId: account.id },
        ...account.familyGroups.map(g => ({ detail: { contains: 'MANUAL_ONLY' }, targetId: g.id }))
      ]
    },
    orderBy: { createdAt: 'desc' }
  });
  
  for (const l of globalAudit) {
    console.log(`[AuditLog] [${l.createdAt.toISOString()}] ${l.action} (${l.targetType}:${l.targetId}) - ${l.detail}`);
  }

  // Extra check: Recent Tasks for the entire account just to get a picture of what happened recently
  console.log('\n=== RECENT TASKS SUMMARY (Last 5) ===');
  const recentTasks = await prisma.task.findMany({
    where: { accountId: account.id },
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  
  for (const t of recentTasks) {
    console.log(`Task ID: ${t.id} | Type: ${t.type} | Status: ${t.status} | Time: ${t.createdAt.toISOString()}`);
  }
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
