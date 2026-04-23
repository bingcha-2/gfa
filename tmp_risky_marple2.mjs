import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  const email = 'marplesidkas373@gmail.com';
  const account = await p.account.findFirst({ where: { loginEmail: email } });
  if (!account) { console.log('Not found'); return; }

  // All tasks for this account, sorted by time
  const tasks = await p.task.findMany({
    where: { accountId: account.id },
    orderBy: { createdAt: 'desc' },
    select: {
      createdAt: true, type: true, status: true, source: true,
      lastErrorCode: true, lastErrorMessage: true,
      familyGroup: { select: { groupName: true } },
    },
  });

  console.log(`\n全部任务 (${tasks.length} 条):\n`);
  for (const t of tasks) {
    const err = t.lastErrorMessage ? ` | ❌ ${t.lastErrorMessage.slice(0, 150)}` : '';
    console.log(`  [${bj(t.createdAt)}] ${t.type} | ${t.status} | ${t.source} | ${t.familyGroup?.groupName}${err}`);
  }

  // Audit logs
  const audits = await p.auditLog.findMany({
    where: { detail: { contains: email } },
    include: { operator: { select: { displayName: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  if (audits.length > 0) {
    console.log(`\n📝 审计日志 (${audits.length} 条):\n`);
    for (const a of audits) {
      console.log(`  [${bj(a.createdAt)}] ${a.action} | ${a.operator?.displayName || '系统'} | ${(a.detail || '').slice(0, 200)}`);
    }
  }
}

main().catch(console.error).finally(() => p.$disconnect());
