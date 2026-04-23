import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const accountEmail = 'HaldimanHeilman@gmail.com';
  
  const account = await prisma.account.findUnique({
    where: { loginEmail: accountEmail },
    include: { familyGroups: true }
  });

  if (!account) return;

  console.log('=== HUNTING FOR MANUAL_ONLY CAUSE ===');
  
  // 1. Check all TaskLogs for this account
  const accountTasks = await prisma.task.findMany({
    where: { accountId: account.id },
    select: { id: true }
  });
  
  const taskIds = accountTasks.map(t => t.id);
  
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
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
