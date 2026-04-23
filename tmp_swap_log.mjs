import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
const p = new PrismaClient();

let output = '';
function log(msg) { output += msg + '\n'; }

const tasks = await p.task.findMany({
  where: { type: 'REPLACE_MEMBER' },
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: { id: true, type: true, status: true, orderId: true, payload: true, createdAt: true, lastErrorCode: true, lastErrorMessage: true, retryCount: true }
});

log('=== Recent REPLACE_MEMBER Tasks ===');
tasks.forEach(t => {
  const payload = JSON.parse(t.payload || '{}');
  log(`  ${t.id} | ${t.status} | retry:${t.retryCount} | ${t.createdAt.toISOString()}`);
  log(`    payload: ${JSON.stringify(payload)}`);
  if (t.lastErrorMessage) log(`    error: [${t.lastErrorCode}] ${t.lastErrorMessage}`);
});

if (tasks.length > 0) {
  const t = tasks[0];
  log(`\n=== Logs for ${t.id} (${t.status}) ===`);
  const logs = await p.taskLog.findMany({
    where: { taskId: t.id },
    orderBy: { createdAt: 'asc' }
  });
  logs.forEach(l => {
    log(`[${l.level.padEnd(5)}] ${l.createdAt.toISOString()} ${l.message}`);
  });

  if (t.orderId) {
    const order = await p.order.findUnique({ where: { id: t.orderId }, select: { orderNo: true, status: true, userEmail: true, orderType: true } });
    log(`\n  Order: ${order?.orderNo} | ${order?.status} | ${order?.userEmail} | type=${order?.orderType}`);
  }
}

writeFileSync('tmp_swap_output.txt', output, 'utf8');
console.log('Done. Written to tmp_swap_output.txt');

await p.$disconnect();
