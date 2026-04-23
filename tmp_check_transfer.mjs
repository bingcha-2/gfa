import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Check the transferBatch that triggered the latest invite
  const batch = await prisma.transferBatch.findUnique({
    where: { id: 'cmnt0p73u002cxkicd84v48do' },
    include: {
      sourceGroup: { select: { groupName: true }, },
      targetGroup: { select: { groupName: true }, },
      tasks: { select: { id: true, type: true, status: true, payload: true, createdAt: true } },
    }
  });
  console.log(JSON.stringify(batch, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
