const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('=== Captcha Unblock Tasks in MANUAL_REVIEW ===');
  const tasks = await prisma.task.findMany({
    where: {
      source: 'captcha-unblock',
      status: 'MANUAL_REVIEW'
    },
    orderBy: { createdAt: 'desc' },
    take: 50
  });

  console.log(`Found ${tasks.length} tasks:`);
  for (const t of tasks) {
    console.log(`ID: ${t.id} | Created: ${t.createdAt.toISOString()} | Code: ${t.lastErrorCode} | Error: ${t.lastErrorMessage}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
