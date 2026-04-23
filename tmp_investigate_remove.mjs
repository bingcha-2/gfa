import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const TARGET_EMAIL = 'aa01093631849@gmail.com';
const TARGET_DATE = new Date('2026-04-18T09:35:00Z');

(async () => {
  // 1. 查找 REMOVE_MEMBER 任务 — payload 中包含此邮箱
  const removeTasks = await p.task.findMany({
    where: {
      type: 'REMOVE_MEMBER',
      payload: { contains: 'aa01093631849' },
    },
    include: {
      logs: { orderBy: { createdAt: 'desc' }, take: 20 },
      account: { select: { loginEmail: true } },
      familyGroup: { select: { groupName: true } },
      order: { select: { orderNo: true, userEmail: true, orderType: true } },
      transferBatch: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`=== REMOVE_MEMBER tasks containing aa01093631849 (${removeTasks.length}) ===\n`);
  for (const t of removeTasks) {
    console.log(`Task ${t.id}`);
    console.log(`  type=${t.type} | status=${t.status} | source=${t.source}`);
    console.log(`  created=${t.createdAt.toISOString()} | started=${t.startedAt?.toISOString()} | finished=${t.finishedAt?.toISOString()}`);
    if (t.account) console.log(`  account: ${t.account.loginEmail}`);
    if (t.familyGroup) console.log(`  group: ${t.familyGroup.groupName}`);
    if (t.order) console.log(`  order: ${t.order.orderNo} (${t.order.orderType}) user=${t.order.userEmail}`);
    if (t.transferBatch) console.log(`  transferBatch: ${t.transferBatch.id} phase=${t.transferBatch.phase}`);
    console.log(`  payload: ${t.payload}`);
    if (t.lastErrorMessage) console.log(`  error: ${t.lastErrorMessage}`);
    if (t.logs.length) {
      console.log(`  logs (${t.logs.length}):`);
      for (const l of t.logs) {
        console.log(`    [${l.createdAt.toISOString().substring(11, 19)}] [${l.level}] ${l.message}`);
      }
    }
    console.log('');
  }

  // 2. 也查一下 09:30-09:40 之间所有涉及 aa01084287993 组的 REMOVE 任务
  const windowTasks = await p.task.findMany({
    where: {
      type: 'REMOVE_MEMBER',
      familyGroup: { groupName: 'aa01084287993' },
      finishedAt: {
        gte: new Date('2026-04-18T09:30:00Z'),
        lte: new Date('2026-04-18T09:40:00Z'),
      },
    },
    include: {
      logs: { orderBy: { createdAt: 'desc' }, take: 15 },
      account: { select: { loginEmail: true } },
      order: { select: { orderNo: true, userEmail: true, orderType: true } },
      transferBatch: true,
    },
    orderBy: { finishedAt: 'asc' },
  });

  console.log(`=== REMOVE tasks in aa01084287993 group around 09:35 (${windowTasks.length}) ===\n`);
  for (const t of windowTasks) {
    console.log(`Task ${t.id}`);
    console.log(`  status=${t.status} | source=${t.source}`);
    console.log(`  finished=${t.finishedAt?.toISOString()}`);
    if (t.account) console.log(`  account: ${t.account.loginEmail}`);
    if (t.order) console.log(`  order: ${t.order.orderNo} (${t.order.orderType}) user=${t.order.userEmail}`);
    if (t.transferBatch) console.log(`  transferBatch: ${t.transferBatch.id} phase=${t.transferBatch.phase}`);
    console.log(`  payload: ${t.payload}`);
    if (t.logs.length) {
      console.log(`  logs:`);
      for (const l of t.logs) {
        console.log(`    [${l.createdAt.toISOString().substring(11, 19)}] [${l.level}] ${l.message}`);
      }
    }
    console.log('');
  }

  // 3. 查审计日志
  const audits = await p.auditLog.findMany({
    where: {
      OR: [
        { detail: { contains: 'aa01093631849' } },
        { detail: { contains: TARGET_EMAIL } },
      ],
      createdAt: {
        gte: new Date('2026-04-18T09:00:00Z'),
        lte: new Date('2026-04-18T10:00:00Z'),
      },
    },
    include: { operator: { select: { email: true, displayName: true } } },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`=== Audit logs around 09:35 (${audits.length}) ===\n`);
  for (const a of audits) {
    console.log(`[${a.createdAt.toISOString()}] ${a.action} | target=${a.targetType}:${a.targetId}`);
    if (a.operator) console.log(`  operator: ${a.operator.displayName} (${a.operator.email})`);
    if (a.detail) console.log(`  detail: ${a.detail.substring(0, 200)}`);
    console.log('');
  }

  await p.$disconnect();
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  await p.$disconnect();
  process.exit(1);
});
