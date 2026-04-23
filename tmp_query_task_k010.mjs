import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// Check last 5 PHONE_VERIFY or agent-account tasks in last 2h
const tasks = await p.task.findMany({
  where: { 
    OR: [
      { type: 'PHONE_VERIFY', createdAt: { gte: new Date(Date.now() - 7200000) } },
      { source: 'agent-account', createdAt: { gte: new Date(Date.now() - 7200000) } }
    ]
  },
  orderBy: { createdAt: 'desc' },
  take: 10,
  select: { id: true, type: true, status: true, source: true, lastErrorCode: true, lastErrorMessage: true, payload: true, createdAt: true, finishedAt: true }
});

console.log(`Found ${tasks.length} recent tasks\n`);
for (const t of tasks) {
  let email = 'unknown';
  try { const p2 = JSON.parse(t.payload); email = p2.email || p2.credentials?.email || 'unknown'; } catch {}
  console.log(`${t.id} | ${t.type} | ${t.status} | ${email} | src:${t.source}`);
  if (t.lastErrorCode) console.log(`  ERROR: ${t.lastErrorCode}: ${t.lastErrorMessage}`);
}

// Check all AgentAccounts
const agents = await p.agentAccount.findMany({ orderBy: { createdAt: 'desc' }, take: 10 });
console.log(`\n=== Recent AgentAccounts (${agents.length}) ===`);
for (const a of agents) {
  console.log(`  ${a.loginEmail} | ${a.status} | task:${a.lastTaskId || 'none'}`);
}

await p.$disconnect();
