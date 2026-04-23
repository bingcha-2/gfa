import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const p = new PrismaClient();
const out = {};

const account = await p.account.findFirst({
  where: { loginEmail: 'VanbellinghenBaldassare269@gmail.com' },
  select: { id: true, loginEmail: true },
});
out.account = account;

const groups = await p.familyGroup.findMany({
  where: { accountId: account.id },
  select: { id: true, groupName: true, status: true, memberCount: true, availableSlots: true },
});
out.groups = groups;

out.membersByGroup = {};
for (const g of groups) {
  const members = await p.familyMember.findMany({
    where: { familyGroupId: g.id },
    select: { id: true, email: true, displayName: true, status: true, googleMemberId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  out.membersByGroup[g.id] = members;
}

const gaiaId = '8348647433419558945';
const logsWithGaia = await p.$queryRawUnsafe(
  `SELECT tl.createdAt, tl.level, tl.message, t.type, t.status as taskStatus
   FROM TaskLog tl JOIN Task t ON tl.taskId = t.id
   WHERE t.familyGroupId IN (SELECT id FROM FamilyGroup WHERE accountId = ?)
   AND tl.message LIKE ?
   ORDER BY tl.createdAt DESC LIMIT 20`,
  account.id, `%${gaiaId}%`
);
out.logsGaia = logsWithGaia;

const logsPlaceholder = await p.$queryRawUnsafe(
  `SELECT tl.createdAt, tl.level, tl.message, t.type, t.status as taskStatus
   FROM TaskLog tl JOIN Task t ON tl.taskId = t.id
   WHERE t.familyGroupId IN (SELECT id FROM FamilyGroup WHERE accountId = ?)
   AND (tl.message LIKE '%gaia.unknown%' OR tl.message LIKE '%placeholder%' OR tl.message LIKE '%T4%')
   ORDER BY tl.createdAt DESC LIMIT 20`,
  account.id
);
out.logsPlaceholder = logsPlaceholder;

writeFileSync('tmp_gaia_unknown_result.json', JSON.stringify(out, null, 2), 'utf8');
console.log('Done');
await p.$disconnect();
