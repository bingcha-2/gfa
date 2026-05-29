const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 最近30分钟内创建的任务
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  
  console.log("=== 最近30分钟创建的任务 ===");
  const recentTasks = await prisma.task.findMany({
    where: {
      createdAt: { gte: thirtyMinAgo }
    },
    orderBy: { createdAt: 'desc' },
    take: 50
  });

  console.log(`Found ${recentTasks.length} tasks in last 30 min:`);
  for (const t of recentTasks) {
    console.log(`ID: ${t.id} | Source: ${t.source} | Type: ${t.type} | Status: ${t.status} | Created: ${t.createdAt.toISOString()} | Error: ${t.lastErrorCode || '-'} | ${t.lastErrorMessage || '-'}`);
  }

  // 如果没有最近30分钟的，查最近2小时
  if (recentTasks.length === 0) {
    console.log("\n=== 最近2小时创建的任务 ===");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const recent2h = await prisma.task.findMany({
      where: {
        createdAt: { gte: twoHoursAgo }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    console.log(`Found ${recent2h.length} tasks in last 2 hours:`);
    for (const t of recent2h) {
      console.log(`ID: ${t.id} | Source: ${t.source} | Type: ${t.type} | Status: ${t.status} | Created: ${t.createdAt.toISOString()} | Error: ${t.lastErrorCode || '-'} | ${t.lastErrorMessage || '-'}`);
    }
  }

  // 当前仍在 PENDING / RUNNING 的任务
  console.log("\n=== 当前 PENDING / RUNNING 的任务 ===");
  const activeTasks = await prisma.task.findMany({
    where: {
      status: { in: ['PENDING', 'RUNNING'] }
    },
    orderBy: { createdAt: 'desc' }
  });
  console.log(`Active (PENDING/RUNNING): ${activeTasks.length}`);
  for (const t of activeTasks) {
    console.log(`ID: ${t.id} | Source: ${t.source} | Type: ${t.type} | Status: ${t.status} | Created: ${t.createdAt.toISOString()}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
