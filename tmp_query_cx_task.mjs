import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const GROUP_NAME = 'SchaneTamai';

// 查找组ID
const group = await prisma.familyGroup.findFirst({
  where: { groupName: GROUP_NAME },
  select: { id: true, accountId: true, groupName: true },
});

if (!group) { console.log('组不存在'); process.exit(1); }
console.log(`组: ${group.groupName} (${group.id})\n`);

// 查所有相关任务
const tasks = await prisma.task.findMany({
  where: { familyGroupId: group.id },
  orderBy: { createdAt: 'desc' },
  take: 20,
  include: {
    logs: { orderBy: { createdAt: 'asc' }, take: 30 },
  },
});

console.log(`=== 相关任务 (${tasks.length}) ===\n`);
for (const t of tasks) {
  console.log(`--- ${t.type} | ${t.status} | ${t.source} | ${t.createdAt.toISOString().substring(0,16)} ---`);
  if (t.lastErrorCode) console.log(`  error: [${t.lastErrorCode}] ${(t.lastErrorMessage || '').substring(0, 200)}`);
  
  // 只打印包含 pending 或 gaia 的日志
  const relevantLogs = t.logs.filter(l => 
    l.message.includes('pending') || l.message.includes('gaia') || 
    l.message.includes('Upserted') || l.message.includes('scraped') ||
    l.message.includes('Scraped') || l.message.includes('unknown') ||
    l.message.includes('member') || l.message.includes('sync')
  );
  if (relevantLogs.length > 0) {
    for (const log of relevantLogs) {
      console.log(`  [${log.level}] ${log.createdAt.toISOString().substring(11,19)} ${log.message.substring(0, 300)}`);
    }
  }
  console.log('');
}

// 查这两个 pending 成员的详细创建记录
const pendingMembers = await prisma.familyMember.findMany({
  where: { email: { contains: 'pending' }, familyGroupId: group.id },
});
console.log(`=== pending 成员详情 ===`);
for (const m of pendingMembers) {
  console.log(JSON.stringify(m, null, 2));
}

await prisma.$disconnect();
