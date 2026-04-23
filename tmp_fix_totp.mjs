import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// 查看最近 OAUTH 任务的 payload
const tasks = await p.task.findMany({
  where: { type: 'OAUTH_AUTHORIZE' },
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: { id: true, status: true, payload: true, accountId: true }
});
for (const t of tasks) {
  console.log(`\nTask ${t.id} [${t.status}] accountId=${t.accountId}`);
  try { console.log('payload:', JSON.stringify(JSON.parse(t.payload), null, 2)); }
  catch { console.log('raw payload:', t.payload); }
}

await p.$disconnect();
