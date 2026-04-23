import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const EMAIL = 'aa01093631849@gmail.com';

(async () => {
  // 1. 订单
  const orders = await p.order.findMany({
    where: { userEmail: EMAIL },
    include: {
      redeemCode: true,
      tasks: {
        include: {
          logs: { orderBy: { createdAt: 'desc' }, take: 30 },
          account: { select: { loginEmail: true } },
          familyGroup: { select: { groupName: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`=== 订单 (${orders.length}) ===`);
  for (const o of orders) {
    console.log(`\n📦 订单 ${o.orderNo} | 类型=${o.orderType} | 状态=${o.status} | 创建=${o.createdAt.toISOString()}`);
    if (o.redeemCode) console.log(`   卡密: ${o.redeemCode.code} (${o.redeemCode.codeType}, ${o.redeemCode.status})`);
    if (o.resultMessage) console.log(`   结果: ${o.resultMessage}`);
    for (const t of o.tasks) {
      console.log(`\n   📋 任务 ${t.id.substring(0,8)} | ${t.type} | ${t.status} | 重试=${t.retryCount}`);
      if (t.account) console.log(`      母号: ${t.account.loginEmail}`);
      if (t.familyGroup) console.log(`      家庭组: ${t.familyGroup.groupName}`);
      if (t.lastErrorMessage) console.log(`      ❌ 错误: ${t.lastErrorMessage}`);
      if (t.logs.length > 0) {
        console.log(`      📝 日志 (最近${t.logs.length}条):`);
        for (const log of t.logs.slice(0, 15)) {
          const time = log.createdAt.toISOString().substring(11, 19);
          console.log(`         [${time}] [${log.level}] ${log.message}`);
        }
      }
    }
  }

  // 2. 家庭成员
  const members = await p.familyMember.findMany({
    where: { email: EMAIL },
    include: { familyGroup: { select: { groupName: true, account: { select: { loginEmail: true } } } } },
  });
  console.log(`\n\n=== 家庭成员记录 (${members.length}) ===`);
  for (const m of members) {
    console.log(`👤 ${m.email} | 角色=${m.role} | 状态=${m.status} | 组=${m.familyGroup.groupName} (${m.familyGroup.account.loginEmail})`);
    if (m.joinedAt) console.log(`   加入: ${m.joinedAt.toISOString()}`);
    if (m.removedAt) console.log(`   移除: ${m.removedAt.toISOString()}`);
    if (m.expiresAt) console.log(`   过期: ${m.expiresAt.toISOString()}`);
  }

  // 3. 邀请记录
  const invites = await p.familyInvite.findMany({
    where: { email: EMAIL },
    include: { familyGroup: { select: { groupName: true } } },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`\n=== 邀请记录 (${invites.length}) ===`);
  for (const inv of invites) {
    console.log(`📩 ${inv.status} | 组=${inv.familyGroup.groupName} | 发送=${inv.sentAt.toISOString()}`);
    if (inv.respondedAt) console.log(`   响应: ${inv.respondedAt.toISOString()}`);
  }

  // 4. 换号记录
  const swaps = await p.swapRecord.findMany({
    where: { OR: [{ oldEmail: EMAIL }, { newEmail: EMAIL }] },
    include: { order: { select: { orderNo: true, userEmail: true } } },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`\n=== 换号记录 (${swaps.length}) ===`);
  for (const s of swaps) {
    console.log(`🔄 ${s.oldEmail} → ${s.newEmail} | ${s.status} | 订单=${s.order.orderNo} | ${s.createdAt.toISOString()}`);
  }

  await p.$disconnect();
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  await p.$disconnect();
  process.exit(1);
});
