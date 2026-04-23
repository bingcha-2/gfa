import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const now = new Date();
const offset = now.getTime() + 8 * 60 * 60 * 1000;
const local = new Date(offset);
const year = local.getUTCFullYear();
const month = local.getUTCMonth();
const day = local.getUTCDate();

// UTC+8 今日 00:00 → UTC
const gte = new Date(Date.UTC(year, month, day, 0, 0, 0) - 8 * 3600 * 1000);
const lt  = new Date(Date.UTC(year, month, day + 1, 0, 0, 0) - 8 * 3600 * 1000);

console.log(`查询范围: ${gte.toISOString()} ~ ${lt.toISOString()} (UTC)`);
console.log(`对应香港时间: ${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')} 00:00 ~ 23:59\n`);

const accounts = await prisma.account.findMany({
  where: { createdAt: { gte, lt } },
  select: { loginEmail: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
});

accounts.forEach((a, i) => {
  const hkt = new Date(a.createdAt.getTime() + 8 * 3600 * 1000);
  const t = hkt.toISOString().slice(11, 19);
  console.log(`${String(i+1).padStart(2)}. ${t}  ${a.loginEmail}`);
});

console.log(`\n共 ${accounts.length} 个`);
await prisma.$disconnect();
