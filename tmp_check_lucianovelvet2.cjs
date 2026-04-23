const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const members = await p.familyMember.findMany({
    where: { email: { contains: 'lucianovelvet2' } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      status: true,
      expiresAt: true,
      joinedAt: true,
      createdAt: true,
      familyGroupId: true,
      familyGroup: { select: { groupName: true } }
    }
  });
  console.log('=== FamilyMember (ordered by createdAt DESC) ===');
  for (const m of members) {
    console.log(`  [${m.status}] group=${m.familyGroup.groupName} expiresAt=${m.expiresAt?.toISOString()} createdAt=${m.createdAt.toISOString()} gid=${m.familyGroupId}`);
  }
  console.log('\nFirst ACTIVE:', members.find(m => m.status === 'ACTIVE')?.familyGroup?.groupName ?? 'none');
  console.log('Fallback [0]:', members[0]?.familyGroup?.groupName, 'status:', members[0]?.status, 'expiresAt:', members[0]?.expiresAt?.toISOString());

  // Also check what checkMigration would see
  const picked = members.find(m => m.status === 'ACTIVE') ?? members[0];
  console.log('\nPicked member:', picked?.familyGroup?.groupName, 'status:', picked?.status, 'expiresAt:', picked?.expiresAt?.toISOString());

  // Check order search with picked group
  if (picked) {
    const order = await p.order.findFirst({
      where: {
        userEmail: 'lucianovelvet2@gmail.com',
        familyGroupId: picked.familyGroupId,
      },
      include: { redeemCode: { select: { code: true, codeType: true } } },
      orderBy: { createdAt: 'desc' }
    });
    console.log('Order for picked group:', order ? `${order.orderNo} expiresAt=${order.expiresAt?.toISOString()}` : 'NONE');
  }

  await p.$disconnect();
})();
