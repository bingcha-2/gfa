import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const email = 'ShunsukeThior17@gmail.com';
  let out = `=== 查询母号: ${email} ===\n`;
  out += `查询时间: ${new Date().toISOString()}\n\n`;

  // 1. 查找账号信息
  const account = await prisma.googleAccount.findFirst({
    where: { email }
  });

  if (!account) {
    out += '❌ 账号未找到，该邮箱在数据库中不存在\n';
    fs.writeFileSync('tmp_account_ShunsukeThior17.txt', out);
    console.log(out);
    return;
  }

  out += '=== 账号基本信息 ===\n';
  out += `ID: ${account.id}\n`;
  out += `邮箱: ${account.email}\n`;
  out += `状态(status): ${account.status}\n`;
  out += `订阅状态(subscriptionStatus): ${account.subscriptionStatus}\n`;
  out += `组状态(groupStatus): ${account.groupStatus ?? 'N/A'}\n`;
  out += `创建时间: ${account.createdAt}\n`;
  out += `更新时间: ${account.updatedAt}\n`;

  // 2. 查找该账号作为母号的家庭组
  const ownedGroups = await prisma.familyGroup.findMany({
    where: { ownerAccountId: account.id },
    include: {
      members: {
        include: { account: true }
      }
    }
  });

  out += `\n=== 作为母号的家庭组 (${ownedGroups.length} 个) ===\n`;
  for (const g of ownedGroups) {
    out += `\n家庭组 ID: ${g.id}\n`;
    out += `  groupName: ${g.groupName ?? 'N/A'}\n`;
    out += `  status: ${g.status}\n`;
    out += `  成员数: ${g.members.length}\n`;
    for (const m of g.members) {
      out += `    - ${m.account?.email ?? '未知'} [${m.role}] 状态:${m.status}\n`;
    }
  }

  // 3. 查该母号家庭组的近期订单
  const groupIds = ownedGroups.map(g => g.id);

  const orders = await prisma.order.findMany({
    where: {
      familyGroupId: { in: groupIds }
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      tasks: {
        orderBy: { createdAt: 'desc' },
        include: {
          logs: {
            orderBy: { createdAt: 'desc' },
            take: 10
          }
        }
      },
      swapRecords: true
    }
  });

  out += `\n=== 近期订单记录 (最近 ${orders.length} 条) ===\n`;
  for (const o of orders) {
    out += `\n订单: ${o.orderNo ?? o.id}\n`;
    out += `  类型(orderType): ${o.orderType}\n`;
    out += `  状态(status): ${o.status}\n`;
    out += `  用户邮箱: ${o.userEmail}\n`;
    out += `  结果信息: ${o.resultMessage ?? ''}\n`;
    out += `  创建时间: ${o.createdAt}\n`;
    out += `  任务数: ${o.tasks.length}\n`;

    for (const t of o.tasks) {
      out += `    任务[${t.id}] 类型:${t.type} 状态:${t.status} 创建:${t.createdAt}\n`;
      if (t.lastErrorMessage) out += `    ❌ 错误: ${t.lastErrorMessage}\n`;
      for (const l of t.logs) {
        out += `      [${l.createdAt.toISOString()}][${l.level}] ${l.message} ${l.extra || ''}\n`;
      }
    }

    if (o.swapRecords.length > 0) {
      out += `  换号记录(${o.swapRecords.length}):\n`;
      for (const sr of o.swapRecords) {
        out += `    ${sr.oldEmail} -> ${sr.newEmail} [${sr.status}]\n`;
      }
    }
  }

  // 4. 查近期所有 Task（包含该账号 payload 关键词）
  out += `\n=== 近7天所有与该邮箱相关的Task ===\n`;
  const recentTasks = await prisma.task.findMany({
    where: {
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    },
    orderBy: { createdAt: 'desc' },
    include: { logs: { orderBy: { createdAt: 'desc' }, take: 5 } }
  });

  const relatedTasks = recentTasks.filter(t =>
    JSON.stringify(t).includes('ShunsukeThior17')
  );

  out += `找到 ${relatedTasks.length} 条相关 Task\n`;
  for (const t of relatedTasks) {
    out += `\nTask[${t.id}] 类型:${t.type} 状态:${t.status} 创建:${t.createdAt}\n`;
    if (t.lastErrorMessage) out += `  ❌ 错误: ${t.lastErrorMessage}\n`;
    out += `  Payload: ${t.payload}\n`;
    for (const l of t.logs) {
      out += `  [${l.createdAt.toISOString()}][${l.level}] ${l.message}\n`;
    }
  }

  fs.writeFileSync('tmp_account_ShunsukeThior17.txt', out);
  console.log(out);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
