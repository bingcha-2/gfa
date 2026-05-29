const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("=== Active Tasks in Database (PENDING / RUNNING) ===");
  const activeTasks = await prisma.task.findMany({
    where: {
      status: { in: ['PENDING', 'RUNNING'] }
    },
    orderBy: { createdAt: 'desc' }
  });
  
  console.log(`Total active tasks: ${activeTasks.length}`);
  for (const t of activeTasks) {
    console.log(`ID: ${t.id} | Source: ${t.source} | Status: ${t.status} | Created: ${t.createdAt}`);
  }

  console.log("\n=== Task Status Summary ===");
  const summary = await prisma.task.groupBy({
    by: ['source', 'status'],
    _count: { id: true },
    orderBy: { source: 'asc' }
  });
  console.table(summary);
}

main().catch(console.error).finally(() => prisma.$disconnect());
