import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const orderId = 'GFA-MNMS93A9-QLWZ';
  // 1. Find the order
  const order = await prisma.order.findUnique({
    where: { orderNo: orderId },
    include: {
      familyGroup: { select: { id: true, groupName: true, accountId: true, status: true } },
      redeemCode: { select: { id: true, code: true, codeType: true, status: true } },
    },
  });

  if (!order) {
    console.log('Order not found');
    return;
  }

  console.log('=== ORDER ===');
  console.log(JSON.stringify(order, null, 2));

  // 2. Find all tasks for this order
  const tasks = await prisma.task.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'asc' },
    include: {
      logs: { orderBy: { createdAt: 'asc' } },
      account: { select: { id: true, name: true, loginEmail: true, status: true } },
      familyGroup: { select: { id: true, groupName: true } },
    },
  });

  console.log(`\n=== TASKS (${tasks.length} total) ===`);
  for (const task of tasks) {
    console.log(`\n--- Task ${task.id} ---`);
    console.log(`  Type: ${task.type}`);
    console.log(`  Status: ${task.status}`);
    console.log(`  RetryCount: ${task.retryCount}/${task.maxRetryCount}`);
    console.log(`  Created: ${task.createdAt}`);
    console.log(`  Started: ${task.startedAt}`);
    console.log(`  Finished: ${task.finishedAt}`);
    console.log(`  ErrorCode: ${task.lastErrorCode}`);
    console.log(`  ErrorMessage: ${task.lastErrorMessage}`);
    console.log(`  Account: ${task.account?.name} (${task.account?.loginEmail}) [${task.account?.status}]`);
    console.log(`  Group: ${task.familyGroup?.groupName}`);
    
    // Parse payload
    try {
      const payload = JSON.parse(task.payload);
      console.log(`  Payload:`, JSON.stringify(payload, null, 4));
    } catch {}

    if (task.logs.length > 0) {
      console.log(`  Logs (${task.logs.length}):`);
      for (const log of task.logs) {
        console.log(`    [${log.level}] ${log.createdAt.toISOString()} - ${log.message}`);
        if (log.extra) {
          try {
            const extra = JSON.parse(log.extra);
            console.log(`      Extra:`, JSON.stringify(extra, null, 6));
          } catch {
            console.log(`      Extra: ${log.extra}`);
          }
        }
      }
    }
  }

  // 3. Check swap records
  const swaps = await prisma.swapRecord.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'asc' },
  });
  if (swaps.length > 0) {
    console.log(`\n=== SWAP RECORDS (${swaps.length}) ===`);
    console.log(JSON.stringify(swaps, null, 2));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
