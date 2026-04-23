import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  // Most recent REPLACE_MEMBER tasks
  console.log('=== 最近的 REPLACE_MEMBER 任务 ===\n');
  const tasks = await p.task.findMany({
    where: { type: 'REPLACE_MEMBER' },
    include: {
      logs: { orderBy: { createdAt: 'asc' }, take: 20 },
      familyGroup: { select: { groupName: true, account: { select: { loginEmail: true } } } },
      order: { select: { orderNo: true, userEmail: true, familyGroupId: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  for (const t of tasks) {
    console.log(`[${bj(t.createdAt)}] ${t.type} | ${t.status}`);
    console.log(`  组: ${t.familyGroup?.groupName} (母号: ${t.familyGroup?.account?.loginEmail})`);
    console.log(`  groupId: ${t.groupId}`);
    console.log(`  订单: ${t.order?.orderNo} | 用户: ${t.order?.userEmail} | order.familyGroupId: ${t.order?.familyGroupId}`);
    console.log(`  结果: ${t.resultMessage ?? 'N/A'}`);
    console.log(`  日志:`);
    for (const log of t.logs) {
      console.log(`    [${bj(log.createdAt)}] [${log.level}] ${log.message}`);
    }
    console.log('');
  }

  // Now check: is there a swap that was just done - using QuaMacartney?
  console.log('\n=== 最近涉及 QuaMacartney 的操作 ===\n');
  // Find the QuaMacartney group
  const qg = await p.familyGroup.findFirst({ where: { groupName: { contains: 'QuaMacartney' } } });
  if (qg) {
    console.log(`QuaMacartney groupId: ${qg.id}`);

    const recentTasks = await p.task.findMany({
      where: { groupId: qg.id },
      include: {
        logs: { orderBy: { createdAt: 'asc' }, take: 15 },
        order: { select: { orderNo: true, userEmail: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    for (const t of recentTasks) {
      console.log(`\n  [${bj(t.createdAt)}] ${t.type} | ${t.status}`);
      console.log(`    订单: ${t.order?.orderNo} | 用户: ${t.order?.userEmail}`);
      console.log(`    结果: ${t.resultMessage ?? 'N/A'}`);
      for (const log of t.logs) {
        console.log(`      [${bj(log.createdAt)}] [${log.level}] ${log.message}`);
      }
    }
  }

  // Critical: the order GFA-MO2S3EDH-6_KC still points to FalkeBawcum group
  // but user was migrated to QuaMacartney. When swap happens,
  // it uses order.familyGroupId (FalkeBawcum) instead of the member's CURRENT group.
  console.log('\n\n=== BUG 分析 ===\n');
  console.log('订单 GFA-MO2S3EDH-6_KC 的 familyGroupId 指向: cmnqthuhp01urxk9kry7ri8x8 (FalkeBawcum)');
  console.log('但实际 t01094761530@gmail.com 当前在 QuaMacartney 组中');
  console.log('→ 用续杯码 swap 时，系统用的是 order 上的旧 groupId，而不是成员当前所在的 group');
}

main().catch(console.error).finally(() => p.$disconnect());
