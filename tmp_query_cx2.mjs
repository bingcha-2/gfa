import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const codeStr = 'CX-YPR6B4';
  
  const codes = await prisma.redeemCode.findMany({
    where: { code: { contains: codeStr } }
  });
  console.log("Matched code in redeemCode:", codes.map(c => c.code));

  const orders = await prisma.order.findMany({
    where: { 
      OR: [
        { orderNo: { contains: codeStr } },
        { redeemCodeId: { contains: codeStr } }
      ]
    }
  });
  console.log("Matched code in order.orderNo:", orders.map(c => c.orderNo));

  const tasks = await prisma.task.findMany({
    where: { payload: { contains: codeStr } }
  });
  console.log("Matched code in tasks:", tasks.map(t => t.id));

  const logs = await prisma.auditLog.findMany({
    where: { detail: { contains: codeStr } }
  });
  console.log("Matched code in auditLog:", logs.map(l => l.detail));
}
main().catch(console.error).finally(() => prisma.$disconnect());
