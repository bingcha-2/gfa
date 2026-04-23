import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// Find all PENDING tasks
const pendingTasks = await p.task.findMany({
  where: { status: 'PENDING' },
  select: {
    id: true,
    type: true,
    status: true,
    source: true,
    priority: true,
    retryCount: true,
    maxRetryCount: true,
    payload: true,
    lastErrorCode: true,
    lastErrorMessage: true,
    createdAt: true,
    startedAt: true,
    finishedAt: true,
    orderId: true,
    familyGroupId: true,
    accountId: true,
    workerId: true,
    transferBatchId: true,
    order: { select: { orderNo: true, userEmail: true, status: true } },
    familyGroup: { select: { groupName: true, status: true } },
    account: { select: { name: true, loginEmail: true, status: true } },
  },
  orderBy: { createdAt: 'asc' },
});

console.log(`=== Found ${pendingTasks.length} PENDING tasks ===\n`);
for (const t of pendingTasks) {
  let payload = {};
  try { payload = JSON.parse(t.payload); } catch {}
  console.log(`Task: ${t.id}`);
  console.log(`  Type: ${t.type} | Source: ${t.source} | Priority: ${t.priority}`);
  console.log(`  Retry: ${t.retryCount}/${t.maxRetryCount}`);
  console.log(`  Created: ${t.createdAt.toISOString()}`);
  console.log(`  Started: ${t.startedAt ?? 'never'} | Finished: ${t.finishedAt ?? 'never'}`);
  console.log(`  Worker: ${t.workerId ?? 'none'}`);
  console.log(`  Account: ${t.account?.loginEmail ?? 'none'} (${t.account?.status ?? '-'})`);
  console.log(`  Group: ${t.familyGroup?.groupName ?? 'none'} (${t.familyGroup?.status ?? '-'})`);
  console.log(`  Order: ${t.order?.orderNo ?? 'none'} (${t.order?.status ?? '-'})`);
  console.log(`  TransferBatch: ${t.transferBatchId ?? 'none'}`);
  console.log(`  Payload: ${JSON.stringify(payload)}`);
  console.log(`  LastError: ${t.lastErrorCode ?? '-'} / ${t.lastErrorMessage ?? '-'}`);
  console.log('');
}

// Also check MANUAL_REVIEW tasks
const reviewTasks = await p.task.count({ where: { status: 'MANUAL_REVIEW' } });
const runningTasks = await p.task.count({ where: { status: 'RUNNING' } });
console.log(`\n=== Other active statuses ===`);
console.log(`RUNNING: ${runningTasks}`);
console.log(`MANUAL_REVIEW: ${reviewTasks}`);

await p.$disconnect();
