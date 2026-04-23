import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  const account = await p.account.findFirst({ where: { loginEmail: 'marplesidkas373@gmail.com' } });
  if (!account) return;

  // Get ALL logs from the successful SYNC task
  const syncTask = await p.task.findFirst({
    where: { accountId: account.id, type: 'SYNC_FAMILY_GROUP', status: 'SUCCESS' },
    orderBy: { createdAt: 'desc' },
    include: { logs: { orderBy: { createdAt: 'asc' } } },
  });

  if (!syncTask) { console.log('No successful sync task'); return; }

  console.log(`SYNC Task: ${syncTask.id} | ${bj(syncTask.createdAt)}\n`);
  for (const l of syncTask.logs) {
    console.log(`  [${bj(l.createdAt)}] [${l.level}] ${l.message}`);
  }

  // Also show the subscription-related fields
  console.log(`\n\n账号订阅信息:`);
  console.log(`  subscriptionStatus: ${account.subscriptionStatus}`);
  console.log(`  subscriptionPlan: ${account.subscriptionPlan}`);
  console.log(`  subscriptionExpiresAt: ${bj(account.subscriptionExpiresAt)}`);
  console.log(`  subscriptionStatusUpdatedAt: ${bj(account.subscriptionStatusUpdatedAt)}`);
  console.log(`  syncError: ${account.syncError}`);
}

main().catch(console.error).finally(() => p.$disconnect());
