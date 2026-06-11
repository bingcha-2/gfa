const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  // Search in multiple tables
  const keyword = 'k1cde219';
  
  // Check agent accounts
  const accounts = await p.account.findMany({
    where: { OR: [
      { id: { contains: keyword } },
      { name: { contains: keyword } },
      { loginEmail: { contains: keyword } },
    ]},
    take: 5,
  });
  if (accounts.length) console.log("=== ACCOUNTS ===\n", JSON.stringify(accounts, null, 2));
  
  // Check orders
  const orders = await p.order.findMany({
    where: { OR: [
      { id: { contains: keyword } },
      { orderNo: { contains: keyword } },
    ]},
    take: 5,
  });
  if (orders.length) console.log("=== ORDERS ===\n", JSON.stringify(orders, null, 2));
  
  // Check tasks - broader search
  const tasks = await p.task.findMany({
    where: { OR: [
      { id: { contains: keyword } },
      { payload: { contains: keyword } },
      { accountId: { contains: keyword } },
    ]},
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  if (tasks.length) console.log("=== TASKS ===\n", JSON.stringify(tasks, null, 2));
  
  if (!accounts.length && !orders.length && !tasks.length) {
    console.log("No results found for:", keyword);
  }
  
  await p.$disconnect();
})();
