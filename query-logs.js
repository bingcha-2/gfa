const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const logs = await p.taskLog.findMany({ 
    where: { taskId: 'cmofh7s26000mxku8amkrqi74' }, 
    orderBy: { createdAt: 'asc' } 
  });
  for (const l of logs) {
    console.log(`[${l.createdAt.toISOString()}] ${l.level}: ${l.message}`);
    if (l.payload) {
      console.log(`  Payload: ${l.payload}`);
    }
  }
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
