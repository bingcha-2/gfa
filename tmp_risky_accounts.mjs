import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  // All RISKY accounts
  const riskyAccounts = await prisma.account.findMany({
    where: { status: 'RISKY' },
    include: {
      familyGroups: {
        select: { id: true, groupName: true, status: true, memberCount: true, availableSlots: true },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  console.log(`\n当前 RISKY 状态的主号: ${riskyAccounts.length} 个\n`);
  console.log('='.repeat(80));

  for (const a of riskyAccounts) {
    console.log(`\n  📧 ${a.loginEmail}`);
    console.log(`    状态: ${a.status} | 更新: ${bj(a.updatedAt)}`);
    
    for (const g of a.familyGroups) {
      console.log(`    组: ${g.groupName} | 状态: ${g.status} | 成员: ${g.memberCount} | 剩余: ${g.availableSlots}`);
      
      // Stuck tasks in this group
      const stuckTasks = await prisma.task.findMany({
        where: {
          familyGroupId: g.id,
          status: { in: ['PENDING', 'RUNNING', 'FAILED_RETRYABLE', 'MANUAL_REVIEW'] },
        },
        include: {
          order: { select: { orderNo: true, orderType: true, status: true, userEmail: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (stuckTasks.length > 0) {
        console.log(`    ⚠️ 阻塞任务 (${stuckTasks.length} 条):`);
        for (const t of stuckTasks) {
          const payload = JSON.parse(t.payload || '{}');
          const action = t.type === 'REPLACE_MEMBER'
            ? `${payload.targetMemberEmail} → ${payload.newUserEmail}`
            : t.type === 'INVITE_MEMBER' ? `邀请 ${payload.userEmail}`
            : t.type;
          console.log(`      [${bj(t.createdAt)}] ${t.type} | ${t.status} | ${action}`);
          if (t.order) {
            console.log(`        订单: ${t.order.orderNo} (${t.order.orderType}, 状态=${t.order.status})`);
          }
          if (t.lastErrorMessage) {
            console.log(`        错误: ${t.lastErrorMessage.slice(0, 120)}`);
          }
        }
      } else {
        console.log(`    ✅ 无阻塞任务`);
      }

      // Stuck orders
      const stuckOrders = await prisma.order.findMany({
        where: {
          familyGroupId: g.id,
          status: { in: ['TASK_QUEUED', 'TASK_RUNNING', 'CREATED', 'CODE_VERIFIED', 'GROUP_ASSIGNED'] },
        },
      });
      if (stuckOrders.length > 0) {
        console.log(`    ⚠️ 卡住的订单: ${stuckOrders.length} 条`);
      }
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
