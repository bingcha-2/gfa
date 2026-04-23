import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const accounts = ['YessiAguilar903@gmail.com', 'SabbGreenburg@gmail.com'];
  
  // Find family groups for each account
  const groupsByAccount = {};
  for (const email of accounts) {
    const allAccounts = await prisma.account.findMany({ include: { familyGroups: true } });
    const account = allAccounts.find(a => a.loginEmail.toLowerCase() === email.toLowerCase());
    if (!account) { console.log(`❌ ${email} not found`); continue; }
    groupsByAccount[email] = account.familyGroups.map(g => g.id);
    console.log(`${email} → groups: ${account.familyGroups.map(g => g.groupName).join(', ')}`);
  }

  // Get all invited emails per account (from Tasks, FamilyInvite, FamilyMember)
  const invitedByAccount = {};
  for (const email of accounts) {
    const groupIds = groupsByAccount[email] || [];
    if (groupIds.length === 0) continue;

    const emails = new Set();

    // From tasks
    const tasks = await prisma.task.findMany({
      where: { familyGroupId: { in: groupIds }, type: 'INVITE_MEMBER' },
    });
    for (const t of tasks) {
      try {
        const p = JSON.parse(t.payload || '{}');
        if (p.userEmail) emails.add(p.userEmail.toLowerCase());
      } catch {}
    }

    // From family members
    const members = await prisma.familyMember.findMany({
      where: { familyGroupId: { in: groupIds }, role: 'member' },
    });
    for (const m of members) emails.add(m.email.toLowerCase());

    // From family invites
    const invites = await prisma.familyInvite.findMany({
      where: { familyGroupId: { in: groupIds } },
    });
    for (const inv of invites) emails.add(inv.email.toLowerCase());

    invitedByAccount[email] = emails;
    console.log(`\n${email}: ${emails.size} unique invited emails`);
  }

  // Find intersection
  const sets = Object.values(invitedByAccount);
  if (sets.length < 2) { console.log('Not enough data'); return; }

  const intersection = [...sets[0]].filter(e => sets[1].has(e));
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`被两个主号都邀请过的账号 (${intersection.length} 个):`);
  console.log('='.repeat(60));
  for (const email of intersection) {
    console.log(`  📧 ${email}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
