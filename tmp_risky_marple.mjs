import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  const email = 'marplesidkas373@gmail.com';

  const account = await p.account.findFirst({
    where: { loginEmail: email },
    include: {
      familyGroups: { select: { groupName: true, status: true, memberCount: true } },
    },
  });

  if (!account) { console.log('Account not found'); return; }

  console.log(`\n📧 ${account.loginEmail}`);
  console.log(`  状态: ${account.status} | 更新: ${bj(account.updatedAt)}`);
  console.log(`  订阅: ${account.subscriptionStatus} | syncError: ${account.syncError}`);
  console.log(`  组: ${account.familyGroups.map(g => `${g.groupName}(${g.status})`).join(', ')}`);

  // Find MANUAL_REVIEW tasks that caused RISKY
  const riskyTasks = await p.task.findMany({
    where: {
      accountId: account.id,
      status: 'MANUAL_REVIEW',
    },
    include: {
      logs: { orderBy: { createdAt: 'asc' } },
      familyGroup: { select: { groupName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n🔧 MANUAL_REVIEW 任务 (${riskyTasks.length} 条):\n`);
  for (const t of riskyTasks) {
    console.log(`  [${bj(t.createdAt)}] ${t.type} | 组: ${t.familyGroup?.groupName}`);
    console.log(`    错误码: ${t.lastErrorCode}`);
    console.log(`    错误: ${(t.lastErrorMessage || '').slice(0, 200)}`);
    console.log(`    日志:`);
    for (const l of t.logs) {
      console.log(`      [${bj(l.createdAt)}] [${l.level}] ${l.message.slice(0, 200)}`);
    }
    console.log();
  }

  // Also check recent failed tasks
  const failedTasks = await p.task.findMany({
    where: {
      accountId: account.id,
      status: { in: ['FAILED_FINAL', 'FAILED_RETRYABLE'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      createdAt: true, type: true, status: true, lastErrorCode: true, lastErrorMessage: true,
    },
  });

  if (failedTasks.length > 0) {
    console.log(`\n❌ 最近失败任务 (${failedTasks.length} 条):\n`);
    for (const t of failedTasks) {
      console.log(`  [${bj(t.createdAt)}] ${t.type} | ${t.status} | ${t.lastErrorCode}`);
      console.log(`    ${(t.lastErrorMessage || '').slice(0, 200)}`);
    }
  }
}

main().catch(console.error).finally(() => p.$disconnect());
