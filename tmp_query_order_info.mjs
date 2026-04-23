import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const order = await p.order.findUnique({
  where: { orderNo: 'GFA-MO71WWND-RTPP' },
  include: {
    tasks: { orderBy: { createdAt: 'desc' }, take: 5 },
    swapRecords: true,
    redeemCode: true,
    familyGroup: {
      include: {
        account: { select: { id: true, loginEmail: true, name: true, status: true } }
      }
    }
  }
});

console.log(JSON.stringify(order, null, 2));
await p.$disconnect();
