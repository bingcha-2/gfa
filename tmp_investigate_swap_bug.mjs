import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  // The SWAP order that linked YessiAguilar903 → JesIturria
  const orderNo = 'GFA-MNHW76LT-QBQG';
  const order = await prisma.order.findFirst({
    where: { orderNo },
    include: {
      familyGroup: { select: { groupName: true } },
      tasks: {
        include: { 
          logs: { orderBy: { createdAt: 'asc' } },
          familyGroup: { select: { groupName: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!order) { console.log('Order not found'); return; }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  订单 ${orderNo} 详细调查`);
  console.log(`  类型: ${order.orderType} | 状态: ${order.status}`);
  console.log(`  用户: ${order.userEmail}`);
  console.log(`  原始组: ${order.familyGroup?.groupName || 'N/A'} (groupId: ${order.familyGroupId})`);
  console.log(`  创建: ${bj(order.createdAt)}`);
  console.log(`  结果: ${order.resultMessage || 'N/A'}`);
  console.log(`${'='.repeat(70)}\n`);

  for (const t of order.tasks) {
    const payload = JSON.parse(t.payload || '{}');
    console.log(`  --- Task ${t.id} ---`);
    console.log(`    类型: ${t.type} | 状态: ${t.status} | 来源: ${t.source}`);
    console.log(`    组: ${t.familyGroup?.groupName || 'N/A'} (groupId: ${t.familyGroupId})`);
    console.log(`    Payload:`);
    console.log(`      targetMemberEmail: ${payload.targetMemberEmail || 'N/A'}`);
    console.log(`      newUserEmail: ${payload.newUserEmail || payload.userEmail || 'N/A'}`);
    console.log(`      accountId: ${payload.accountId || 'N/A'}`);
    console.log(`      familyGroupId: ${payload.familyGroupId || 'N/A'}`);
    if (t.lastErrorMessage) {
      console.log(`    ❌ 错误: ${t.lastErrorMessage.slice(0, 200)}`);
    }
    console.log(`    时间: ${bj(t.startedAt)} → ${bj(t.finishedAt)}`);
    console.log(`    日志 (${t.logs.length} 条):`);
    for (const l of t.logs) {
      console.log(`      [${bj(l.createdAt)}] [${l.level}] ${l.message.slice(0, 200)}`);
    }
    console.log();
  }

  // Also look at the other SWAP order: GFA-MNHQ5FDP-VGS3
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  前一个 SWAP 订单 GFA-MNHQ5FDP-VGS3`);
  console.log(`${'='.repeat(70)}\n`);
  
  const order2 = await prisma.order.findFirst({
    where: { orderNo: 'GFA-MNHQ5FDP-VGS3' },
    include: {
      familyGroup: { select: { groupName: true } },
      tasks: {
        include: { 
          logs: { orderBy: { createdAt: 'asc' } },
          familyGroup: { select: { groupName: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (order2) {
    console.log(`  类型: ${order2.orderType} | 状态: ${order2.status}`);
    console.log(`  用户: ${order2.userEmail}`);
    console.log(`  组: ${order2.familyGroup?.groupName || 'N/A'}`);
    console.log(`  创建: ${bj(order2.createdAt)}`);
    console.log(`  结果: ${order2.resultMessage || 'N/A'}`);
    
    for (const t of order2.tasks) {
      const payload = JSON.parse(t.payload || '{}');
      console.log(`\n  --- Task ${t.id} ---`);
      console.log(`    类型: ${t.type} | 状态: ${t.status}`);
      console.log(`    组: ${t.familyGroup?.groupName || 'N/A'}`);
      console.log(`    操作: ${payload.targetMemberEmail} → ${payload.newUserEmail || payload.userEmail}`);
      if (t.lastErrorMessage) {
        console.log(`    ❌ 错误: ${t.lastErrorMessage.slice(0, 200)}`);
      }
      console.log(`    日志 (${t.logs.length} 条):`);
      for (const l of t.logs) {
        console.log(`      [${bj(l.createdAt)}] [${l.level}] ${l.message.slice(0, 200)}`);
      }
    }
  }

  // Now let's trace the member t01091395490 in JesIturria
  console.log(`\n\n${'='.repeat(70)}`);
  console.log(`  t01091395490 在 JesIturria 组的记录`);
  console.log(`${'='.repeat(70)}\n`);
  
  const jesGroup = await prisma.familyGroup.findFirst({ where: { groupName: 'JesIturria' } });
  if (jesGroup) {
    const jesMember = await prisma.familyMember.findFirst({
      where: { familyGroupId: jesGroup.id, email: { contains: 't01091395490' } },
    });
    if (jesMember) {
      console.log(`  状态: ${jesMember.status} | 创建: ${bj(jesMember.createdAt)} | 移除: ${bj(jesMember.removedAt)}`);
    }

    // What task invited t01091395490 into JesIturria?
    const jesTasks = await prisma.task.findMany({
      where: { familyGroupId: jesGroup.id, payload: { contains: 't01091395490' } },
      include: { order: { select: { orderNo: true, orderType: true } } },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`  JesIturria 中涉及 t01091395490 的任务:`);
    for (const t of jesTasks) {
      const p = JSON.parse(t.payload || '{}');
      console.log(`    [${bj(t.createdAt)}] ${t.type} | ${t.status} | ${p.targetMemberEmail || ''} → ${p.newUserEmail || p.userEmail || ''}`);
      console.log(`      订单: ${t.order ? `${t.order.orderNo} (${t.order.orderType})` : '❌ 无'}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
