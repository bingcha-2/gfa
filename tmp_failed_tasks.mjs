import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// 最近3个失败的任务（FAILED_FINAL 或 FAILED_RETRYABLE）
const tasks = await p.task.findMany({
  where: {
    status: { in: ['FAILED_FINAL', 'FAILED_RETRYABLE', 'MANUAL_REVIEW'] }
  },
  orderBy: { updatedAt: 'desc' },
  take: 3,
  include: {
    logs: {
      orderBy: { createdAt: 'desc' },
      take: 15
    },
    account: { select: { loginEmail: true, status: true } },
    order: { select: { id: true, orderType: true, orderNo: true, userEmail: true } },
    familyGroup: { select: { groupName: true } }
  }
});

if (tasks.length === 0) {
  console.log('没有找到失败任务');
  await p.$disconnect();
  process.exit(0);
}

for (const task of tasks) {
  console.log('='.repeat(70));
  console.log(`Task ID:       ${task.id}`);
  console.log(`Type:          ${task.type}`);
  console.log(`Status:        ${task.status}`);
  console.log(`Retry Count:   ${task.retryCount} / ${task.maxRetryCount}`);
  console.log(`Account:       ${task.account?.loginEmail ?? 'N/A'} (${task.account?.status ?? 'N/A'})`);
  console.log(`Family Group:  ${task.familyGroup?.groupName ?? 'N/A'}`);
  console.log(`Order:         ${task.order?.orderNo ?? 'N/A'} | ${task.order?.orderType ?? 'N/A'} | ${task.order?.userEmail ?? 'N/A'}`);
  console.log(`Last Error:    ${task.lastErrorCode ?? ''} - ${task.lastErrorMessage ?? 'none'}`);
  console.log(`Started At:    ${task.startedAt}`);
  console.log(`Finished At:   ${task.finishedAt}`);
  console.log(`Updated At:    ${task.updatedAt}`);
  console.log(`--- Task Logs (最新15条) ---`);
  for (const log of task.logs.reverse()) {
    const ts = log.createdAt.toISOString().replace('T', ' ').slice(0, 19);
    console.log(`  [${ts}] [${log.level.padEnd(5)}] ${log.message}`);
    if (log.extra) {
      try {
        const ex = JSON.parse(log.extra);
        console.log(`           extra: ${JSON.stringify(ex).slice(0, 200)}`);
      } catch {
        console.log(`           extra: ${String(log.extra).slice(0, 200)}`);
      }
    }
  }
}

await p.$disconnect();
