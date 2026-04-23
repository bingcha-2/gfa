import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const acc = await prisma.account.findFirst({
  where: { adspowerProfileId: 'k1apjssb' },
  select: { id: true, loginEmail: true, adspowerProfileId: true, status: true }
});
console.log(JSON.stringify(acc, null, 2));
await prisma.$disconnect();
