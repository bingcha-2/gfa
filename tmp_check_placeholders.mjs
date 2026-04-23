/**
 * Deep check: for each placeholder, show ALL members in its group
 * to understand why no merge candidate was found.
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const placeholders = await prisma.familyMember.findMany({
    where: {
      email: { endsWith: '@gaia.unknown' },
      status: { in: ['ACTIVE', 'PENDING'] },
    },
    select: { email: true, googleMemberId: true, familyGroupId: true, status: true },
  });

  // Only show first 3 groups for brevity
  const groups = [...new Set(placeholders.map(p => p.familyGroupId))].slice(0, 3);

  for (const gid of groups) {
    const groupPhs = placeholders.filter(p => p.familyGroupId === gid);
    const members = await prisma.familyMember.findMany({
      where: { familyGroupId: gid, status: { not: 'REMOVED' } },
      select: { email: true, googleMemberId: true, status: true, displayName: true },
      orderBy: { createdAt: 'asc' },
    });

    const group = await prisma.familyGroup.findUnique({
      where: { id: gid },
      select: { groupName: true, memberCount: true, availableSlots: true },
    });

    console.log(`\n=== Group: ${group?.groupName} (${gid}) ===`);
    console.log(`  memberCount=${group?.memberCount}, slots=${group?.availableSlots}`);
    console.log(`  Placeholders: ${groupPhs.length}`);
    console.log(`  Active members:`);
    for (const m of members) {
      const isPlaceholder = m.email.endsWith('@gaia.unknown');
      const hasGaia = m.googleMemberId ? '✅' : '❌';
      console.log(`    ${isPlaceholder ? '🔴' : '🟢'} ${m.email} | gaiaId=${hasGaia} ${m.googleMemberId ?? ''} | status=${m.status} | name=${m.displayName ?? 'none'}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
