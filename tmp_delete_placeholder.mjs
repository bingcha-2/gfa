import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.familyMember.deleteMany({
    where: { email: 'pending-8348647433419558945@gaia.unknown' },
  });
  console.log('Deleted records:', result.count);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
