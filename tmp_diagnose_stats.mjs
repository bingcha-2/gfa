import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// ── 1. 显示服务器时区信息 ──
const now = new Date();
console.log('== 服务器时区诊断 ==');
console.log('process.env.TZ:', process.env.TZ ?? '(未设置)');
console.log('服务器本地时间:', now.toString());
console.log('UTC 时间:       ', now.toISOString());
console.log('本地与UTC偏差:  ', -now.getTimezoneOffset() / 60, '小时\n');

// ── 2. 还原 stats.controller.ts 的实际计算 ──
const offset = now.getTime() + 8 * 60 * 60 * 1000;
const local = new Date(offset);
const year  = local.getUTCFullYear();
const month = local.getUTCMonth();
const day   = local.getUTCDate();

// ★ 关键：new Date(y,m,d) 使用服务器本地时区！
const dayStartLocal = new Date(year, month, day, 0, 0, 0, 0);
const dayEndLocal   = new Date(year, month, day + 1, 0, 0, 0, 0);
const gte_ctrl = new Date(dayStartLocal.getTime() - 8 * 60 * 60 * 1000);
const lt_ctrl  = new Date(dayEndLocal.getTime()   - 8 * 60 * 60 * 1000);

console.log('== stats.controller 实际使用的查询范围 ==');
console.log('gte:', gte_ctrl.toISOString(), '→ HKT:', new Date(gte_ctrl.getTime()+8*3600*1000).toISOString().slice(0,19).replace('T',' '));
console.log('lt: ', lt_ctrl.toISOString(),  '→ HKT:', new Date(lt_ctrl.getTime() +8*3600*1000).toISOString().slice(0,19).replace('T',' '));
console.log();

// ── 3. 正确的 UTC+8 今日范围（用Date.UTC避免本地TZ影响）──
const gte_correct = new Date(Date.UTC(year, month, day,   0, 0, 0) - 8*3600*1000);
const lt_correct  = new Date(Date.UTC(year, month, day+1, 0, 0, 0) - 8*3600*1000);

console.log('== 正确的 UTC+8 今日查询范围 ==');
console.log('gte:', gte_correct.toISOString(), '→ HKT:', new Date(gte_correct.getTime()+8*3600*1000).toISOString().slice(0,19).replace('T',' '));
console.log('lt: ', lt_correct.toISOString(),  '→ HKT:', new Date(lt_correct.getTime() +8*3600*1000).toISOString().slice(0,19).replace('T',' '));
console.log();

// ── 4. 两个范围各查多少账号 ──
const [countCtrl, countCorrect] = await Promise.all([
  prisma.account.count({ where: { createdAt: { gte: gte_ctrl,    lt: lt_ctrl    } } }),
  prisma.account.count({ where: { createdAt: { gte: gte_correct, lt: lt_correct } } }),
]);
console.log('== 账号数量对比 ==');
console.log('controller 范围 (可能有Bug):', countCtrl);
console.log('正确 UTC+8 今日范围:         ', countCorrect);

// ── 5. 如果有差异，列出多出来的账号 ──
if (countCtrl !== countCorrect) {
  console.log('\n== 多出来的账号（错误范围有、正确范围没有）==');
  const extra = await prisma.account.findMany({
    where: {
      createdAt: { gte: gte_ctrl, lt: lt_ctrl },
      NOT: { createdAt: { gte: gte_correct, lt: lt_correct } },
    },
    select: { loginEmail: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  extra.forEach(a => {
    const hkt = new Date(a.createdAt.getTime() + 8*3600*1000);
    console.log('  ', hkt.toISOString().slice(0,19).replace('T',' '), '(HKT)', a.loginEmail);
  });

  console.log('\n== 正确范围有、controller范围没有的账号 ==');
  const missing = await prisma.account.findMany({
    where: {
      createdAt: { gte: gte_correct, lt: lt_correct },
      NOT: { createdAt: { gte: gte_ctrl, lt: lt_ctrl } },
    },
    select: { loginEmail: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  missing.forEach(a => {
    const hkt = new Date(a.createdAt.getTime() + 8*3600*1000);
    console.log('  ', hkt.toISOString().slice(0,19).replace('T',' '), '(HKT)', a.loginEmail);
  });
}

await prisma.$disconnect();
