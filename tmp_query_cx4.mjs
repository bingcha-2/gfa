import { PrismaClient } from '@prisma/client';
import fs from 'fs';
const prisma = new PrismaClient();

async function main() {
  const orderId = 'cmnr9nq9m008qxk60xz9px6l0';
  
  // 1. All tasks for this order, ASCENDING order
  const tasks = await prisma.task.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    include: {
      logs: {
        orderBy: { createdAt: 'asc' }
      }
    }
  });

  const out = [];

  out.push("=== Tasks details ===");
  for (const t of tasks) {
    out.push(`Task [${t.type}] id: ${t.id} status: ${t.status}`);
    out.push(`Payload: ${t.payload}`);
    out.push('Logs:');
    for (const l of t.logs) {
      out.push(`  [${l.createdAt.toISOString()}] ${l.level}: ${l.message} (extra: ${l.extra})`);
    }
    out.push('');
  }

  // 2. Initial AuditLogs for the order/redeem code
  const logs = await prisma.auditLog.findMany({
    where: {
      OR: [
        { targetId: orderId },
        { detail: { contains: 'CX-YPR6B4MGF4P416O7' } },
        { detail: { contains: 'lain.anchor.666' } }
      ]
    },
    orderBy: { createdAt: 'asc' }
  });

  out.push("=== Audit Logs ===");
  for (const l of logs) {
    out.push(`[${l.createdAt.toISOString()}] [${l.action}] Target:${l.targetType}(${l.targetId}) Detail: ${l.detail}`);
  }

  // 3. FamilyGroup members
  const group = await prisma.familyGroup.findUnique({
    where: { id: "cmnfd0p9s003mxkb09l1uk3kl" },
    include: {
      members: true,
      orders: true
    }
  });

  if (group) {
    out.push("=== Group Members currently ===");
    for (const m of group.members) {
      out.push(`${m.email} / ${m.role} / ${m.status} / Joined: ${m.joinedAt}`);
    }
  }

  fs.writeFileSync('tmp_cx_deep.txt', out.join('\n'));
}

main().catch(console.error).finally(() => prisma.$disconnect());
