import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bj = (d) => d ? new Date(d.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) : 'N/A';

async function main() {
  // Search audit logs for this replace action
  const audits = await p.auditLog.findMany({
    where: { action: 'REPLACE_MEMBER', detail: { contains: 'aa01094370039' } },
    include: { operator: { select: { displayName: true, email: true, role: true } } },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`审计日志 (${audits.length} 条):\n`);
  for (const a of audits) {
    console.log(`  [${bj(a.createdAt)}] ${a.action}`);
    console.log(`    操作人: ${a.operator?.displayName} (${a.operator?.email}, ${a.operator?.role})`);
    console.log(`    详情: ${a.detail}`);
  }

  // Also check all REPLACE_MEMBER audits in the same time window
  if (!audits.length) {
    console.log('\n直接搜索 detail 未找到，扩大搜索同时段...\n');
    const all = await p.auditLog.findMany({
      where: {
        action: 'REPLACE_MEMBER',
        createdAt: { gte: new Date('2026-04-20T16:10:00Z'), lte: new Date('2026-04-20T16:25:00Z') },
      },
      include: { operator: { select: { displayName: true, email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
    });
    console.log(`同时段 REPLACE_MEMBER (${all.length} 条):\n`);
    for (const a of all) {
      console.log(`  [${bj(a.createdAt)}] 操作人: ${a.operator?.displayName} (${a.operator?.email})`);
      console.log(`    ${(a.detail || '').slice(0, 300)}`);
    }
  }
}

main().catch(console.error).finally(() => p.$disconnect());
