import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  // 1. t01094761530 member records
  console.log('=== t01094761530@gmail.com FamilyMember 记录 ===\n');
  const members1 = await p.familyMember.findMany({
    where: { email: 't01094761530@gmail.com' },
    include: { familyGroup: { select: { groupName: true, account: { select: { loginEmail: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  for (const m of members1) {
    console.log(`  组: ${m.familyGroup.groupName} (母号: ${m.familyGroup.account.loginEmail})`);
    console.log(`    状态: ${m.status} | 加入: ${bj(m.joinedAt)} | 移除: ${bj(m.removedAt)}`);
    console.log(`    到期: ${bj(m.expiresAt)} | groupId: ${m.groupId}`);
    console.log('');
  }

  // 2. ingleedeli173 member records
  console.log('=== ingleedeli173@gmail.com FamilyMember 记录 ===\n');
  const members2 = await p.familyMember.findMany({
    where: { email: 'ingleedeli173@gmail.com' },
    include: { familyGroup: { select: { groupName: true, account: { select: { loginEmail: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  for (const m of members2) {
    console.log(`  组: ${m.familyGroup.groupName} (母号: ${m.familyGroup.account.loginEmail})`);
    console.log(`    状态: ${m.status} | 加入: ${bj(m.joinedAt)} | 移除: ${bj(m.removedAt)}`);
    console.log(`    到期: ${bj(m.expiresAt)} | groupId: ${m.groupId}`);
    console.log('');
  }

  // 3. Redeem code
  console.log('=== 兑换码 CX-2TSP6P5C9WH496BS ===\n');
  const code = await p.redeemCode.findFirst({ where: { code: 'CX-2TSP6P5C9WH496BS' } });
  if (code) {
    console.log(`  类型: ${code.type} | 状态: ${code.status} | orderId: ${code.orderId}`);
    if (code.orderId) {
      const order = await p.order.findUnique({
        where: { id: code.orderId },
        include: { familyGroup: { select: { groupName: true, account: { select: { loginEmail: true } } } } },
      });
      if (order) {
        console.log(`  订单: ${order.orderNo} | 类型: ${order.type} | 状态: ${order.status}`);
        console.log(`  用户邮箱: ${order.userEmail} | familyGroupId: ${order.familyGroupId}`);
        console.log(`  家庭组: ${order.familyGroup?.groupName} (母号: ${order.familyGroup?.account?.loginEmail})`);
        console.log(`  结果: ${order.resultMessage ?? 'N/A'}`);

        const tasks = await p.task.findMany({
          where: { orderId: order.id },
          include: { 
            logs: { orderBy: { createdAt: 'asc' } },
            familyGroup: { select: { groupName: true, account: { select: { loginEmail: true } } } },
          },
          orderBy: { createdAt: 'asc' },
        });
        console.log(`\n  关联任务 (${tasks.length} 个):`);
        for (const t of tasks) {
          console.log(`\n    [${bj(t.createdAt)}] ${t.type} | ${t.status}`);
          console.log(`    groupId: ${t.groupId} → 组: ${t.familyGroup?.groupName} (母号: ${t.familyGroup?.account?.loginEmail})`);
          console.log(`    结果: ${t.resultMessage ?? 'N/A'}`);
          for (const log of t.logs) {
            console.log(`      [${bj(log.createdAt)}] [${log.level}] ${log.message}`);
          }
        }
      }
    }
  }

  // 4. Swap records
  console.log('\n\n=== SwapRecord ===\n');
  const swaps = await p.swapRecord.findMany({
    where: {
      OR: [
        { oldEmail: 't01094761530@gmail.com' },
        { newEmail: 't01094761530@gmail.com' },
        { oldEmail: 'ingleedeli173@gmail.com' },
        { newEmail: 'ingleedeli173@gmail.com' },
      ],
    },
    include: { order: { select: { orderNo: true, familyGroupId: true, familyGroup: { select: { groupName: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  for (const s of swaps) {
    console.log(`  [${bj(s.createdAt)}] ${s.oldEmail} → ${s.newEmail} | ${s.status}`);
    console.log(`    订单: ${s.order?.orderNo} | 组: ${s.order?.familyGroup?.groupName} | familyGroupId: ${s.order?.familyGroupId}`);
  }

  // 5. Check the order's original familyGroupId vs current
  console.log('\n\n=== Order familyGroupId 追踪 ===\n');
  const allOrders = await p.order.findMany({
    where: { userEmail: 't01094761530@gmail.com' },
    include: { familyGroup: { select: { groupName: true, account: { select: { loginEmail: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  for (const o of allOrders) {
    console.log(`  [${bj(o.createdAt)}] ${o.orderNo} | ${o.type} | ${o.status}`);
    console.log(`    groupId: ${o.familyGroupId} → ${o.familyGroup?.groupName} (母号: ${o.familyGroup?.account?.loginEmail})`);
    console.log(`    结果: ${o.resultMessage ?? 'N/A'}`);
    console.log('');
  }
}

main().catch(console.error).finally(() => p.$disconnect());
