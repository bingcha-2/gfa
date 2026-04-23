import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.account.findMany({
    where: { loginEmail: 'MikerlangeMariza@gmail.com' },
    include: { familyGroups: true }
  });
  
  if (accounts.length === 0) {
    console.log("Account MikerlangeMariza@gmail.com not found in DB.");
  } else {
    const acc = accounts[0];
    console.log(`Account ID: ${acc.id}, Status: ${acc.status}`);
    
    for (const fg of acc.familyGroups) {
      console.log(`Family Group: ${fg.id}, Status: ${fg.status}, availableSlots: ${fg.availableSlots}`);
    }
  }
}
main().catch(console.error).finally(() => { prisma.$disconnect(); });
