import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const orders = await p.order.findMany({
  where: {
    orderNo: { contains: 'MNFR7AUE-IGNN' }
  },
  include: { tasks: true }
});
console.log("Orders found:", JSON.stringify(orders, null, 2));

const tasks = await p.task.findMany({
  where: {
    OR: [
      { payload: { contains: 'MNFR7AUE-IGNN' } },
      { lastErrorMessage: { contains: 'MNFR7AUE-IGNN' } }
    ]
  }
});
console.log("Tasks found:", JSON.stringify(tasks, null, 2));

const logs = await p.taskLog.findMany({
  where: {
    OR: [
      { message: { contains: 'MNFR7AUE-IGNN' } },
      { extra: { contains: 'MNFR7AUE-IGNN' } }
    ]
  }
});
console.log("TaskLogs found:", JSON.stringify(logs, null, 2));

await p.$disconnect();
