import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const targetEmail = 'boughterbaires@gmail.com';

async function main() {
  const results = {};

  results.Users = await prisma.user.findMany({ where: { email: targetEmail } });
  
  results.FamilyMembers = await prisma.familyMember.findMany({ 
    where: { email: targetEmail },
    include: { familyGroup: { include: { account: true } } }
  });

  results.FamilyInvites = await prisma.familyInvite.findMany({ 
    where: { email: targetEmail },
    include: { familyGroup: { include: { account: true } } }
  });

  results.Orders = await prisma.order.findMany({ 
    where: { userEmail: targetEmail },
    include: { swapRecords: true }
  });

  results.SwapRecords = await prisma.swapRecord.findMany({
    where: {
      OR: [
        { oldEmail: targetEmail },
        { newEmail: targetEmail }
      ]
    },
    include: { order: true }
  });

  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
