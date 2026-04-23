import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const orderId = 'MNFQZMFT-FI76';
  
  // See if there's any order at all with this
  const order = await prisma.order.findUnique({
      where: { id: orderId }
  });
  console.log('Order exact match:', order);
  
  if (!order) {
     const orders = await prisma.order.findMany({
         where: { id: { contains: 'MNFQZMFT' } }
     });
     console.log('Orders containing MNFQZMFT:', orders);
  }

  // Look at recent orders
  const recentOrders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5
  });
  console.log('5 most recent orders:', recentOrders);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
