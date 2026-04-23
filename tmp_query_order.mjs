import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  const order = await p.order.findFirst({
    where: { orderNo: 'GFA-MO6UCYT7-VCIL' },
    include: { familyGroup: { select: { groupName: true } } },
  });
  if (!order) { console.log('订单不存在'); return; }

  console.log(`📦 订单: ${order.orderNo}`);
  console.log(`   类型: ${order.type} | 状态: ${order.status} | 结果: ${order.resultMessage ?? 'N/A'}`);
  console.log(`   用户邮箱: ${order.userEmail}`);
  console.log(`   家庭组: ${order.familyGroup?.groupName ?? 'N/A'}`);
  console.log(`   创建: ${bj(order.createdAt)}`);
  console.log('');

  // Find the last failed task for this order
  const tasks = await p.task.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'desc' },
    include: {
      logs: { orderBy: { createdAt: 'asc' } },
    },
  });

  console.log(`🔧 关联任务 (${tasks.length} 个):\n`);
  for (const t of tasks) {
    const isFailed = ['FAILED', 'MANUAL_REVIEW', 'TIMEOUT'].includes(t.status);
    console.log(`  [${bj(t.createdAt)}] ${t.type} | ${t.status} | 来源: ${t.source}`);
    console.log(`    任务ID: ${t.id}`);
    if (t.resultMessage) console.log(`    结果: ${t.resultMessage}`);
    console.log(`    日志 (${t.logs.length} 条):`);
    // For the last failed task, show all logs; for others, show summary
    if (isFailed || t === tasks[0]) {
      for (const log of t.logs) {
        console.log(`      [${bj(log.createdAt)}] [${log.level}] ${log.message}`);
      }
    } else {
      // Just show first and last 3
      const shown = [...t.logs.slice(0, 2), ...t.logs.slice(-2)];
      for (const log of shown) {
        console.log(`      [${bj(log.createdAt)}] [${log.level}] ${log.message}`);
      }
      if (t.logs.length > 4) console.log(`      ... (省略 ${t.logs.length - 4} 条)`);
    }
    console.log('');
  }
}

main().catch(console.error).finally(() => p.$disconnect());
