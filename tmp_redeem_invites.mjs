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
console.log(`对应的香港时间: ${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}\n`);

const orders = await prisma.order.findMany({
  where: {
    orderType: "JOIN",
    redeemCodeId: { not: null },
    createdAt: { gte, lt },
  },
  include: {
    tasks: {
      select: {
        id: true,
        type: true,
        status: true,
        createdAt: true,
      }
    }
  },
  orderBy: { createdAt: 'asc' },
});

if (orders.length === 0) {
  console.log("今日暂无卡密邀请记录(JOIN订单)");
}

orders.forEach((order, i) => {
  const hkt = new Date(order.createdAt.getTime() + 8 * 3600 * 1000);
  const t = hkt.toISOString().slice(11, 19);
  
  // Format target email: normally stored in members (family sync) or tasks
  const reqEmail = order.requestEmail || "未提供邮箱";
  
  console.log(`[${String(i+1).padStart(2)}] 订单 ${order.id}`);
  console.log(`     时间: ${t} (HKT)`);
  console.log(`     请求邮箱: ${reqEmail}`);
  console.log(`     关联卡密ID: ${order.redeemCodeId}`);
  console.log(`     状态: ${order.status}`);
  
  if (order.tasks && order.tasks.length > 0) {
    console.log(`     相关任务:`);
    order.tasks.forEach(task => {
        const taskTime = new Date(task.createdAt.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 19);
        console.log(`       - 任务 ID: ${task.id} | 类型: ${task.type} | 状态: ${task.status} | 创建时间: ${taskTime}`);
    });
  } else {
    console.log(`     相关任务: 无`);
  }
  console.log('');
});

console.log(`\n共 ${orders.length} 个卡密邀请订单`);
await prisma.$disconnect();
