import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.familyMember.deleteMany({
    where: {
      email: { endsWith: '@gaia.unknown' },
      status: 'REMOVED'
    }
  });
  console.log("Cleaned up placeholders:", result.count);
}

main().catch(console.error).finally(() => prisma.$disconnect());
