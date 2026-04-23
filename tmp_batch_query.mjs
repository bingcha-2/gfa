import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const emails = [
    'RoekleEriksen@gmail.com',
    'BilalChahal53@gmail.com',
    'DulcezitaBotones@gmail.com'
  ];

  for (const email of emails) {
    console.log(`\n======================================================`);
    console.log(`=== ACCOUNT: ${email} ===`);
    console.log(`======================================================`);
    
    // Attempt exact and case-insensitive match
    let account = await prisma.account.findUnique({
      where: { loginEmail: email },
      include: { familyGroups: true }
    });

    if (!account) {
      account = await prisma.account.findFirst({
        where: { loginEmail: { equals: email, mode: 'insensitive' } },
        include: { familyGroups: true }
      });
    }

    if (!account) {
      console.log(`-> Account ${email} not found.`);
      continue;
    }

    console.log(`ID: ${account.id}`);
    console.log(`Status: ${account.status}`);
    console.log(`Sync Error: ${account.syncError}`);
    console.log(`Subscription: ${account.subscriptionStatus} (Expires: ${account.subscriptionExpiresAt})`);
    
    for (const group of account.familyGroups) {
      console.log(`\n[Family Group: ${group.groupName} (${group.id})]`);
      console.log(`-> Status: ${group.status} | Members: ${group.memberCount}/${group.maxMembers} | Available: ${group.availableSlots}`);
      
      const groupAuditLogs = await prisma.auditLog.findMany({
        where: { targetId: group.id },
        orderBy: { createdAt: 'desc' }
      });

      const manualToggles = groupAuditLogs.filter(l => l.action === 'TOGGLE_AUTO_ASSIGN' && l.detail.includes('MANUAL_ONLY'));
      
      if (manualToggles.length > 0) {
        console.log(`-> 🕵️ Cause of MANUAL_ONLY setup: Manual UI Toggle`);
        for (const t of manualToggles) {
          console.log(`   - Time: ${t.createdAt.toISOString()} | Detail: ${t.detail}`);
        }
      } else {
        console.log(`-> No UI TOGGLE_AUTO_ASSIGN -> MANUAL_ONLY found in AuditLog for this group.`);
      }
    }

    // 1. Check all TaskLogs for this account for SUSPENDED or MANUAL_ONLY
    const accountTasks = await prisma.task.findMany({
      where: { accountId: account.id },
      select: { id: true, type: true, status: true, createdAt: true }
    });
    
    const taskIds = accountTasks.map(t => t.id);
    
    const suspendedLogs = await prisma.taskLog.findMany({
      where: {
        taskId: { in: taskIds },
        message: { contains: 'SUSPENDED' }
      },
      orderBy: { createdAt: 'desc' },
      include: { task: true }
    });

    if (suspendedLogs.length > 0) {
      console.log(`\n[⚠️ SYSTEM DETECTION OF SUSPENSION]`);
      for (const log of suspendedLogs) {
        console.log(`   - Time: ${log.createdAt.toISOString()} | Task: ${log.task.type} | Msg: ${log.message}`);
      }
    }
  }
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
