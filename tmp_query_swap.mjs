import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const orderNo = 'GFA-MNN590DY-U-RJ';
  
  const order = await prisma.order.findUnique({
    where: { orderNo },
    include: {
      swapRecords: true,
      tasks: true
    }
  });

  fs.writeFileSync('tmp_order_details.json', JSON.stringify(order, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
