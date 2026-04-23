import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const email = 'a506328730@gmail.com';

async function main() {
  // 1. All tasks related to this email — full detail
  const tasks = await prisma.task.findMany({
    where: { payload: { contains: email } },
    orderBy: { createdAt: 'asc' },
    include: {
      familyGroup: { select: { groupName: true, id: true } },
      account: { select: { loginEmail: true } },
      order: { select: { orderNo: true } },
      transferBatch: { select: { id: true, phase: true, sourceGroupId: true, targetGroupId: true } },
      logs: { orderBy: { createdAt: 'asc' } },
    },
  });
  console.log(`\n=== 所有任务 (${tasks.length}) — 按时间升序 ===`);
  for (const t of tasks) {
    console.log(`\n  任务ID: ${t.id}`);
    console.log(`  类型: ${t.type} | 状态: ${t.status} | 来源: ${t.source}`);
    console.log(`  家庭组: ${t.familyGroup?.groupName ?? '-'} (${t.familyGroupId ?? '-'})`);
    console.log(`  母号: ${t.account?.loginEmail ?? '-'}`);
    console.log(`  订单: ${t.order?.orderNo ?? '-'}`);
    console.log(`  迁移批次: ${t.transferBatch?.id ?? '-'} ${t.transferBatch ? `(阶段: ${t.transferBatch.phase})` : ''}`);
    console.log(`  创建: ${t.createdAt.toISOString()} | 完成: ${t.finishedAt?.toISOString() ?? '未完成'}`);
    console.log(`  重试: ${t.retryCount}/${t.maxRetryCount}`);
    try { console.log(`  Payload: ${t.payload}`); } catch {}
    if (t.lastErrorCode) console.log(`  错误码: ${t.lastErrorCode}`);
    if (t.lastErrorMessage) console.log(`  错误: ${t.lastErrorMessage}`);
    if (t.logs.length > 0) {
      console.log(`  --- 日志 (${t.logs.length}) ---`);
      for (const l of t.logs) {
        console.log(`    [${l.level}] ${l.createdAt.toISOString()} ${l.message.slice(0, 200)}`);
      }
    }
  }

  // 2. Family members — check actual status
  const members = await prisma.familyMember.findMany({
    where: { email: email },
    include: { familyGroup: { select: { groupName: true, id: true, lastSyncedAt: true } } },
  });
  console.log(`\n\n=== 家庭组成员记录 (${members.length}) ===`);
  for (const m of members) {
    console.log(`  组: ${m.familyGroup?.groupName ?? m.familyGroupId} | 状态: ${m.status} | 角色: ${m.role}`);
    console.log(`    到期: ${m.expiresAt?.toISOString() ?? '-'} | 加入: ${m.joinedAt?.toISOString() ?? '-'} | 移除: ${m.removedAt?.toISOString() ?? '-'}`);
    console.log(`    组最后同步: ${m.familyGroup?.lastSyncedAt?.toISOString() ?? '未同步'}`);
  }

  // 3. Check REMOVE tasks for this email 
  const removeTasks = await prisma.task.findMany({
    where: { 
      type: 'REMOVE_MEMBER',
      payload: { contains: email },
    },
    orderBy: { createdAt: 'asc' },
    include: { familyGroup: { select: { groupName: true } } },
  });
  console.log(`\n=== REMOVE_MEMBER 任务 (${removeTasks.length}) ===`);
  for (const t of removeTasks) {
    console.log(`  ${t.id.slice(0,12)}… | ${t.status} | 组: ${t.familyGroup?.groupName ?? '-'} | ${t.createdAt.toISOString()}`);
    console.log(`  Payload: ${t.payload}`);
  }

  // 4. Invites status
  const invites = await prisma.familyInvite.findMany({
    where: { email },
    include: { familyGroup: { select: { groupName: true } } },
  });
  console.log(`\n=== 邀请记录详情 (${invites.length}) ===`);
  for (const inv of invites) {
    console.log(`  组: ${inv.familyGroup?.groupName ?? '-'} | 状态: ${inv.status} | 发送: ${inv.sentAt.toISOString()} | 响应: ${inv.respondedAt?.toISOString() ?? '无'} | 过期: ${inv.expiresAt?.toISOString() ?? '-'}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
