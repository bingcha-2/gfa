import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  // Find ALL recent tasks for this account (not just by accountId - also check payload for email)
  const tasks = await p.task.findMany({
    where: {
      OR: [
        { accountId: 'cmo6z1zow00vwxkxwg9f5ymim' },
        { payload: { contains: 'danitaalbig874' } },
      ],
      type: { in: ['OAUTH_AUTHORIZE', 'PHONE_VERIFY'] },
    },
    include: {
      logs: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  console.log(`OAuth/Phone 任务 (${tasks.length} 个):\n`);
  for (const t of tasks) {
    console.log(`[${bj(t.createdAt)}] ${t.type} | ${t.status}`);
    console.log(`  结果: ${t.resultMessage ?? t.lastErrorMessage ?? 'N/A'}`);
    console.log(`  日志 (${t.logs.length} 条):`);
    for (const log of t.logs) {
      console.log(`    [${bj(log.createdAt)}] [${log.level}] ${log.message}`);
    }
    console.log('');
  }

  // Also check AgentAccount
  console.log('\n=== AgentAccount ===\n');
  const agent = await p.agentAccount.findFirst({
    where: { loginEmail: { contains: 'danitaalbig874' } },
  });
  if (agent) {
    console.log(`  loginEmail: ${agent.loginEmail}`);
    console.log(`  status: ${agent.status}`);
    console.log(`  refreshToken: ${agent.refreshToken ? '有 ('+agent.refreshToken.substring(0,20)+'...)' : '无'}`);
    console.log(`  tokenObtainedAt: ${bj(agent.tokenObtainedAt)}`);
    console.log(`  lastTaskId: ${agent.lastTaskId}`);
  } else {
    console.log('  未找到 AgentAccount 记录');
  }
}

main().catch(console.error).finally(() => p.$disconnect());
