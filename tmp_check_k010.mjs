import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// Check AgentAccount
const agent = await p.agentAccount.findFirst({
  where: { loginEmail: { contains: 'k01047407768' } },
});
if (agent) {
  console.log('AgentAccount found:');
  console.log(`  email: ${agent.loginEmail}`);
  console.log(`  status: ${agent.status}`);
  console.log(`  refreshToken: ${agent.refreshToken ? 'YES' : 'NO'}`);
  console.log(`  tokenObtainedAt: ${agent.tokenObtainedAt?.toISOString() || '-'}`);
} else {
  console.log('No AgentAccount found for k01047407768');
}

// Check Account
const acct = await p.account.findFirst({
  where: { loginEmail: { contains: 'k01047407768' } },
});
if (acct) {
  console.log('\nAccount found:');
  console.log(`  email: ${acct.loginEmail}`);
  console.log(`  status: ${acct.status}`);
}

await p.$disconnect();
