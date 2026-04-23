import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();
const targetEmail = 'gzchenglisong@gmail.com';

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

  results.Tasks = await prisma.task.findMany({
    where: {
      payload: {
        contains: targetEmail
      }
    }
  });

  fs.writeFileSync('tmp_gzchenglisong_result.json', JSON.stringify(results, null, 2), 'utf-8');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
