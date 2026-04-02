import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BATCH_SIZE = 100;
const DEFAULT_EXPIRY_DAYS = 30;

async function backfillMemberExpiry() {
  console.log('Starting backfill for FamilyMember.expiresAt...');

  let updatedCount = 0;
  let cursor: string | undefined;

  while (true) {
    const members = await prisma.familyMember.findMany({
      where: {
        expiresAt: null,
        status: { in: ['ACTIVE', 'PENDING'] },
        joinedAt: { not: null },
      },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });

    if (members.length === 0) break;

    const updates = members
      .filter((m) => m.joinedAt !== null)
      .map((m) =>
        prisma.familyMember.update({
          where: { id: m.id },
          data: {
            expiresAt: new Date(m.joinedAt!.getTime() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
          },
        })
      );

    await prisma.$transaction(updates);
    updatedCount += updates.length;
    cursor = members[members.length - 1].id;

    console.log(`Updated ${updatedCount} members so far (batch cursor: ${cursor})`);
  }

  console.log(`Backfill complete! Total updated: ${updatedCount}`);
}

backfillMemberExpiry()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
