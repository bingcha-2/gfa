import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const codeStr = 'CX-YPR6B4MGF4P416O7';
  console.log(`Checking details for actual code: ${codeStr}`);
  
  // 1. Check RedeemCode
  let redeemCode = null;
  let rCodeId = null;
  try {
    redeemCode = await prisma.redeemCode.findUnique({
      where: { code: codeStr },
      include: {
        order: {
          include: {
            familyGroup: {
              select: { id: true, groupName: true, account: { select: { loginEmail: true, id: true } } }
            }
          }
        }
      }
    });
    if (redeemCode) {
      console.log("=== Redeem Code Details ===");
      console.log(JSON.stringify(redeemCode, null, 2));
      rCodeId = redeemCode.id;
    }
  } catch(e) { console.log(e) }

  // 2. Check Orders and Swap records
  let order = null;
  if (rCodeId) {
    const orders = await prisma.order.findMany({
      where: { redeemCodeId: rCodeId },
      include: {
        familyGroup: {
          select: { id: true, groupName: true, account: { select: { loginEmail: true } } }
        },
        swapRecords: { orderBy: { createdAt: 'desc' } }
      }
    });
    if (orders.length > 0) {
      console.log("\n=== Related Orders ===");
      console.log(JSON.stringify(orders, null, 2));
      order = orders[0];
    }
  }

  // 3. Find Tasks related to the order
  if (order) {
    const tasks = await prisma.task.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
    console.log("\n=== Recent Tasks ===");
    tasks.forEach(t => {
      console.log(`- ${t.createdAt.toISOString()} | Type: ${t.type} | Status: ${t.status}`);
      console.log(`  Payload: ${t.payload}`);
      if (t.lastErrorMessage) console.log(`  Error: ${t.lastErrorMessage}`);
    });
  }

  // 4. Audit logs for the orderId
  if (order) {
    const auditLogs = await prisma.auditLog.findMany({
      where: { targetId: order.id },
      orderBy: { createdAt: 'desc' },
      take: 10
    });
    console.log("\n=== Audit Logs ===");
    auditLogs.forEach(a => {
      console.log(`- ${a.createdAt.toISOString()} | Action: ${a.action} | Detail: ${a.detail}`);
    });
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
