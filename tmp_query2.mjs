import { PrismaClient } from '@prisma/client';
import fs from 'fs';
const p = new PrismaClient();
const orders = await p.order.findMany({
  where: {
    orderNo: { contains: 'MNFR7AUE-IGNN' }
  },
  include: { tasks: { include: { logs: true } } }
});
fs.writeFileSync('tmp-order-result.json', JSON.stringify(orders, null, 2));
await p.$disconnect();
