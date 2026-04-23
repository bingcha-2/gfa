import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const orderNo = 'GFA-MNMS93A9-QLWZ';

  const order = await prisma.order.findUnique({
    where: { orderNo },
    include: {
      tasks: {
        where: { type: 'REPLACE_MEMBER' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      familyGroup: true,
    },
  });

  if (!order) { console.log('Order not found'); return; }

  console.log(`Order: ${order.orderNo}, status: ${order.status}`);
  const latestTask = order.tasks[0];
  if (latestTask) console.log(`Latest task: ${latestTask.id}, status: ${latestTask.status}`);

  // Clear Redis cooldown via redis-cli
  const accountId = order.familyGroup?.accountId;
  if (accountId) {
    const { execSync } = await import('child_process');
    try {
      execSync(`redis-cli DEL gfa:login-cooldown:${accountId}`, { stdio: 'pipe' });
      execSync(`redis-cli DEL gfa:account-failures:${accountId}`, { stdio: 'pipe' });
      console.log(`Cleared Redis cooldown/failures for ${accountId}`);
    } catch { console.log('redis-cli not available or keys already expired — OK'); }
  }

  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'FAILED', resultMessage: 'Cooldown deadlock resolved. User can re-submit.' },
  });
  console.log('Order marked FAILED');

  if (latestTask && !['SUCCESS','REPLACED_AND_INVITE_SENT'].includes(latestTask.status)) {
    await prisma.task.update({
      where: { id: latestTask.id },
      data: {
        status: 'FAILED_FINAL',
        lastErrorCode: 'COOLDOWN_DEADLOCK_FIXED',
        lastErrorMessage: 'Manually resolved: cooldown deadlock. Bug patched.',
        finishedAt: new Date(),
      },
    });
    console.log(`Task ${latestTask.id} marked FAILED_FINAL`);
  }

  const sr = await prisma.swapRecord.updateMany({
    where: { orderId: order.id, status: 'PENDING' },
    data: { status: 'FAILED' },
  });
  console.log(`${sr.count} SwapRecord(s) marked FAILED`);
  console.log('Done!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
