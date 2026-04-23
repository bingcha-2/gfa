import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const hostEmail = 'VanbellinghenBaldassare269@gmail.com';
  
  // Find the account
  const account = await prisma.account.findUnique({
    where: { email: hostEmail },
    include: {
      familyGroup: {
        include: {
          members: true
        }
      }
    }
  });

  if (!account) {
    console.log(`Account ${hostEmail} not found`);
    return;
  }

  console.log(`Account: ${account.email}`);
  console.log(`Family Group ID: ${account.familyGroup?.id}`);
  console.log(`Available Slots: ${account.familyGroup?.availableSlots}`);
  console.log(`Member Count: ${account.familyGroup?.memberCount}`);
  
  console.log('\nMembers:');
  for (const member of account.familyGroup?.members || []) {
    console.log(`- ID: ${member.id}, Email: ${member.email}, Role: ${member.role}, Status: ${member.status}, GAIA: ${member.googleMemberId}`);
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
