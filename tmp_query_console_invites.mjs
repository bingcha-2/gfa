import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const prisma = new PrismaClient();

async function main() {
  const result = {};

  // 1. Find latest console invite tasks
  const consoleTasks = await prisma.task.findMany({
    where: {
      type: "INVITE_MEMBER",
      orderId: null,
      transferBatchId: null,
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      familyGroup: {
        select: { id: true, groupName: true, memberCount: true }
      },
      account: {
        select: { id: true, name: true, loginEmail: true }
      },
    }
  });
  
  result.consoleTasks = consoleTasks.map(t => ({
    id: t.id,
    status: t.status,
    source: t.source,
    created: t.createdAt.toISOString(),
    started: t.startedAt?.toISOString(),
    finished: t.finishedAt?.toISOString(),
    payload: JSON.parse(t.payload || '{}'),
    account: t.account?.loginEmail,
    groupName: t.familyGroup?.groupName,
    groupMembers: t.familyGroup?.memberCount,
  }));

  // 2. Audit logs
  const auditLogs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 30,
    include: {
      operator: {
        select: { id: true, email: true, displayName: true }
      }
    }
  });
  
  result.auditLogs = auditLogs.map(a => ({
    time: a.createdAt.toISOString(),
    action: a.action,
    targetType: a.targetType,
    targetId: a.targetId,
    operator: a.operator?.displayName,
    operatorEmail: a.operator?.email,
    detail: a.detail ? JSON.parse(a.detail) : null,
  }));

  // 3. Member count summary
  const activeMembers = await prisma.familyMember.count({ where: { status: "ACTIVE" } });
  const pendingMembers = await prisma.familyMember.count({ where: { status: "PENDING" } });
  result.memberStats = { active: activeMembers, pending: pendingMembers, total: activeMembers + pendingMembers };

  writeFileSync('tmp_console_invite_result.json', JSON.stringify(result, null, 2), 'utf-8');
  console.log('Done. Check tmp_console_invite_result.json');
}

main().catch(console.error).finally(() => prisma.$disconnect());
