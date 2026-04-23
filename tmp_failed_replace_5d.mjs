import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000);

  const failedTasks = await prisma.task.findMany({
    where: {
      type: 'REPLACE_MEMBER',
      status: { in: ['FAILED_FINAL', 'FAILED_RETRYABLE', 'MANUAL_REVIEW'] },
      createdAt: { gte: fiveDaysAgo },
    },
    include: {
      familyGroup: { select: { groupName: true } },
      account: { select: { loginEmail: true } },
      order: { select: { orderNo: true, orderType: true, status: true, userEmail: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\n最近5天失败的 REPLACE_MEMBER 任务: ${failedTasks.length} 条\n`);
  console.log('='.repeat(90));

  for (const t of failedTasks) {
    const payload = JSON.parse(t.payload || '{}');
    console.log(`\n  Task: ${t.id}`);
    console.log(`    时间: ${bj(t.createdAt)} | 状态: ${t.status}`);
    console.log(`    组: ${t.familyGroup?.groupName || 'N/A'} | 主号: ${t.account?.loginEmail || 'N/A'}`);
    console.log(`    操作: ${payload.targetMemberEmail || '?'} → ${payload.newUserEmail || '?'}`);
    console.log(`    错误码: ${t.lastErrorCode || 'N/A'}`);
    console.log(`    错误: ${(t.lastErrorMessage || 'N/A').slice(0, 200)}`);
    if (t.order) {
      console.log(`    订单: ${t.order.orderNo} (${t.order.orderType}, 状态=${t.order.status}, user=${t.order.userEmail})`);
    } else {
      console.log(`    订单: 无`);
    }
    console.log(`    重试次数: ${t.attemptsMade || 0}`);
  }

  // Summary by error code
  const byCode = {};
  for (const t of failedTasks) {
    const code = t.lastErrorCode || 'NO_CODE';
    byCode[code] = (byCode[code] || 0) + 1;
  }
  console.log(`\n\n${'='.repeat(60)}`);
  console.log(`  按错误码统计:`);
  console.log('='.repeat(60));
  for (const [code, count] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${code}: ${count} 条`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
