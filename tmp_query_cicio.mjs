import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const searchTerm = 'cicionewarrior';
  const searchTerm2 = 'pending-7673764133483401579';

  console.log(`Searching for accounts...`);
  const accounts = await prisma.account.findMany({
    where: { loginEmail: { contains: searchTerm } }
  });
  console.log('Accounts:', accounts.map(a => a.loginEmail));

  console.log(`\nSearching for groups...`);
  const groups = await prisma.familyGroup.findMany({
    where: { groupName: { contains: searchTerm } }
  });
  console.log('Groups:', groups.map(g => g.groupName));

  console.log(`\nSearching for members...`);
  const members = await prisma.familyMember.findMany({
    where: { 
      OR: [
        { email: { contains: searchTerm } },
        { email: { contains: searchTerm2 } }
      ]
    },
    include: {
      familyGroup: {
        include: { account: true }
      }
    }
  });

  for (const member of members) {
    console.log(`- Member Email: ${member.email}`);
    console.log(`  Status: ${member.status}`);
    console.log(`  Family Group ID: ${member.familyGroup.id} (${member.familyGroup.groupName})`);
    console.log(`  Account: ${member.familyGroup.account.loginEmail}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
