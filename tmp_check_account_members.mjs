import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const hostEmail = 'VanbellinghenBaldassare269@gmail.com';
  
  const account = await prisma.account.findFirst({
    where: { loginEmail: hostEmail },
    include: {
      familyGroups: {
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

  console.log(`Account: ${account.loginEmail}`);
  if (account.familyGroups && account.familyGroups.length > 0) {
    const fg = account.familyGroups[0];
    console.log(`Family Group ID: ${fg.id}`);
    console.log(`Available Slots: ${fg.availableSlots}`);
    console.log(`Member Count: ${fg.memberCount}`);
    
    console.log('\nMembers:');
    for (const member of fg.members || []) {
      console.log(`- ID: ${member.id}, Email: ${member.email}, Role: ${member.role}, Status: ${member.status}, GAIA: ${member.googleMemberId}`);
    }
  } else {
    console.log('No family group found.');
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
