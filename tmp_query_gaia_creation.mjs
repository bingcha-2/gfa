import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const p = new PrismaClient();

const allMembers = await p.familyMember.findMany({
  where: { familyGroupId: 'cmnizzub3001fxk8szt8soqt4' },
  select: { email: true, status: true, googleMemberId: true, createdAt: true, displayName: true },
  orderBy: { createdAt: 'asc' },
});

const s3Logs = await p.$queryRawUnsafe(
  `SELECT tl.createdAt, tl.level, tl.message
   FROM TaskLog tl JOIN Task t ON tl.taskId = t.id
   WHERE t.familyGroupId = 'cmnizzub3001fxk8szt8soqt4'
   AND tl.message LIKE '%8348647433419558945%'
   AND tl.message LIKE '%Leaf%'
   ORDER BY tl.createdAt ASC`,
);

writeFileSync('tmp_gaia_identity.json', JSON.stringify({ members: allMembers, s3Logs }, null, 2), 'utf8');
console.log('Done');
await p.$disconnect();
