import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const prisma = new PrismaClient();

async function main() {
  // Today range in UTC+8
  const now = new Date();
  const offset = now.getTime() + 8 * 60 * 60 * 1000;
  const local = new Date(offset);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const gte = new Date(Date.UTC(year, month, day, 0, 0, 0) - 8 * 60 * 60 * 1000);
  const lt = new Date(Date.UTC(year, month, day + 1, 0, 0, 0) - 8 * 60 * 60 * 1000);

  console.log(`Query range: ${gte.toISOString()} ~ ${lt.toISOString()}`);

  const tasks = await prisma.task.findMany({
    where: {
      type: "INVITE_MEMBER",
      orderId: null,
      transferBatchId: null,
      createdAt: { gte, lt },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      familyGroup: { select: { groupName: true } },
      account: { select: { loginEmail: true } },
    }
  });

  console.log(`Total console invites today: ${tasks.length}`);

  const rows = tasks.map((t, i) => {
    const p = JSON.parse(t.payload || '{}');
    const created = new Date(t.createdAt.getTime() + 8 * 60 * 60 * 1000);
    const timeStr = created.toISOString().replace('T', ' ').slice(0, 19);
    return {
      '#': i + 1,
      time_bj: timeStr,
      status: t.status,
      userEmail: p.userEmail || '',
      groupName: t.familyGroup?.groupName || '',
      account: t.account?.loginEmail || '',
      expiresAt: p.memberExpiresAt || '',
      taskId: t.id,
    };
  });

  writeFileSync('tmp_console_invites_60.json', JSON.stringify(rows, null, 2), 'utf-8');
  
  // Also print a compact table
  console.log('\n# | 北京时间 | 状态 | 邀请邮箱 | 目标组 | 账号');
  console.log('--|---------|------|---------|-------|-----');
  for (const r of rows) {
    console.log(`${r['#']} | ${r.time_bj} | ${r.status} | ${r.userEmail} | ${r.groupName} | ${r.account}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
