import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  const email = 'jimibro666@gmail.com';

  // 1. Get the REMOVE task details
  const removeTasks = await p.task.findMany({
    where: { type: 'REMOVE_MEMBER', payload: { contains: email } },
    select: {
      id: true, createdAt: true, status: true, source: true, payload: true,
      familyGroupId: true,
      familyGroup: { select: { groupName: true } },
      account: { select: { loginEmail: true } },
      orderId: true,
      order: { select: { orderNo: true, orderType: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\n🔧 REMOVE_MEMBER 任务 (${removeTasks.length} 条):\n`);
  for (const t of removeTasks) {
    console.log(`  Task ID: ${t.id}`);
    console.log(`    时间: ${bj(t.createdAt)} | 状态: ${t.status} | 来源: ${t.source}`);
    console.log(`    组: ${t.familyGroup?.groupName} | 主号: ${t.account?.loginEmail}`);
    console.log(`    Payload: ${t.payload}`);
    console.log(`    订单ID: ${t.orderId || '无'}`);
    if (t.order) console.log(`    订单: ${t.order.orderNo} (${t.order.orderType})`);
  }

  // 2. Audit logs for this email
  const auditLogs = await p.auditLog.findMany({
    where: {
      OR: [
        { detail: { contains: email } },
        { detail: { contains: 'jimibro666' } },
      ],
    },
    include: {
      operator: { select: { displayName: true, email: true, role: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n📝 审计日志 (${auditLogs.length} 条):\n`);
  for (const a of auditLogs) {
    console.log(`  [${bj(a.createdAt)}] ${a.action} | targetType: ${a.targetType} | targetId: ${a.targetId}`);
    console.log(`    操作人: ${a.operator?.displayName || '系统'} (${a.operator?.email || 'N/A'}, ${a.operator?.role || 'N/A'})`);
    try {
      const detail = JSON.parse(a.detail || '{}');
      console.log(`    详情: ${JSON.stringify(detail).slice(0, 300)}`);
    } catch {
      console.log(`    详情: ${(a.detail || '').slice(0, 300)}`);
    }
    console.log();
  }

  // 3. Check if there was a REPLACE_MEMBER task in the same group around the same time
  if (removeTasks.length > 0) {
    const groupId = removeTasks[0].familyGroupId;
    const removeTime = removeTasks[0].createdAt;
    const windowStart = new Date(removeTime.getTime() - 5 * 60 * 1000);
    const windowEnd = new Date(removeTime.getTime() + 5 * 60 * 1000);

    const nearbyTasks = await p.task.findMany({
      where: {
        familyGroupId: groupId,
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        id: true, type: true, status: true, source: true, payload: true, createdAt: true,
        order: { select: { orderNo: true, orderType: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    console.log(`\n🔍 移除前后5分钟内同组的任务:\n`);
    for (const t of nearbyTasks) {
      console.log(`  [${bj(t.createdAt)}] ${t.type} | ${t.status} | 来源: ${t.source}`);
      console.log(`    Payload: ${(t.payload || '').slice(0, 200)}`);
      if (t.order) console.log(`    订单: ${t.order.orderNo} (${t.order.orderType})`);
      console.log();
    }
  }

  // 4. Also check: who created the invite task right after?
  const inviteAudit = await p.auditLog.findMany({
    where: {
      createdAt: { gte: new Date('2026-04-20T09:00:00Z') },
      action: { in: ['REMOVE_MEMBER', 'INVITE_MEMBER', 'REPLACE_MEMBER', 'MIGRATE_MEMBER', 'BULK_INVITE'] },
      detail: { contains: 'jimibro666' },
    },
    include: { operator: { select: { displayName: true, email: true, role: true } } },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n📝 4/20 当天与 jimibro666 相关的操作审计:\n`);
  for (const a of inviteAudit) {
    console.log(`  [${bj(a.createdAt)}] ${a.action}`);
    console.log(`    操作人: ${a.operator?.displayName || '系统'} (${a.operator?.email}, ${a.operator?.role})`);
    console.log(`    详情: ${(a.detail || '').slice(0, 300)}`);
    console.log();
  }
}

main().catch(console.error).finally(() => p.$disconnect());
