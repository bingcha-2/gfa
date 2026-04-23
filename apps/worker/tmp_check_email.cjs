// Check DB for all tasks involving gvc99774@gmail.com across ALL FGs
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Find all tasks involving this email
  const tasks = await p.task.findMany({
    where: {
      payload: { contains: 'gvc99774@gmail.com' }
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      type: true,
      status: true,
      source: true,
      familyGroupId: true,
      accountId: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
      lastErrorCode: true,
      lastErrorMessage: true,
      payload: true,
    }
  });

  console.log(`=== All tasks for gvc99774@gmail.com (${tasks.length} total) ===\n`);
  for (const t of tasks) {
    console.log(`[${t.type}] ${t.id}`);
    console.log(`  Status: ${t.status} | Source: ${t.source} | FG: ${t.familyGroupId}`);
    console.log(`  Created: ${t.createdAt.toISOString()} | Started: ${t.startedAt?.toISOString() ?? 'null'} | Finished: ${t.finishedAt?.toISOString() ?? 'null'}`);
    if (t.lastErrorCode) console.log(`  Error: ${t.lastErrorCode} - ${t.lastErrorMessage}`);
    console.log(`  Payload: ${t.payload?.slice(0, 200)}`);
    console.log();
  }

  // Also check family member records
  const members = await p.familyMember.findMany({
    where: { email: 'gvc99774@gmail.com' },
    include: { familyGroup: { select: { id: true, groupName: true, accountId: true } } },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`=== FamilyMember records for gvc99774@gmail.com (${members.length}) ===\n`);
  for (const m of members) {
    console.log(`[${m.status}] FG: ${m.familyGroup.groupName} (${m.familyGroupId})`);
    console.log(`  Joined: ${m.joinedAt?.toISOString() ?? 'null'} | Expires: ${m.expiresAt?.toISOString() ?? 'null'}`);
    console.log(`  Created: ${m.createdAt.toISOString()}`);
    console.log();
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
