import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const targetEmail = 'SoaresIsa258@gmail.com';
  const allAccounts = await prisma.account.findMany({ include: { familyGroups: true } });
  const account = allAccounts.find(a => a.loginEmail.toLowerCase() === targetEmail.toLowerCase());

  if (!account) { console.log('Account not found'); return; }

  for (const group of account.familyGroups) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  组名: ${group.groupName}`);
    console.log(`  组ID: ${group.id}`);
    console.log(`  状态: ${group.status}`);
    console.log(`  maxMembers: ${group.maxMembers}`);
    console.log(`  memberCount: ${group.memberCount}`);
    console.log(`  availableSlots: ${group.availableSlots}`);
    console.log(`  pendingInviteCount: ${group.pendingInviteCount}`);
    console.log(`  yearlyChangeCount: ${group.yearlyChangeCount} / ${group.yearlyChangeLimit}`);
    console.log(`  lastSyncedAt: ${group.lastSyncedAt?.toISOString() || 'never'}`);
    console.log(`${'='.repeat(60)}`);

    // All members in DB
    const allMembers = await prisma.familyMember.findMany({
      where: { familyGroupId: group.id },
      orderBy: { createdAt: 'asc' },
    });

    const active = allMembers.filter(m => m.status === 'ACTIVE');
    const pending = allMembers.filter(m => m.status === 'PENDING');
    const removed = allMembers.filter(m => m.status === 'REMOVED');

    console.log(`\n  DB成员统计: ACTIVE=${active.length}, PENDING=${pending.length}, REMOVED=${removed.length}, Total=${allMembers.length}`);
    
    console.log(`\n  ACTIVE 成员:`);
    for (const m of active) {
      console.log(`    ${m.email} | joined: ${m.joinedAt?.toISOString() || 'N/A'} | expires: ${m.expiresAt?.toISOString() || '永久'}`);
    }

    console.log(`\n  PENDING 成员:`);
    for (const m of pending) {
      console.log(`    ${m.email} | joined: ${m.joinedAt?.toISOString() || 'N/A'} | expires: ${m.expiresAt?.toISOString() || '永久'}`);
    }

    // Pending invites
    const sentInvites = await prisma.familyInvite.findMany({
      where: { familyGroupId: group.id, status: 'SENT' },
    });
    console.log(`\n  FamilyInvite (SENT): ${sentInvites.length} 条`);
    for (const inv of sentInvites) {
      console.log(`    ${inv.email} | sentAt: ${inv.sentAt.toISOString()}`);
    }

    // Active tasks
    const activeTasks = await prisma.task.findMany({
      where: {
        familyGroupId: group.id,
        type: 'INVITE_MEMBER',
        status: { in: ['PENDING', 'RUNNING'] },
      },
    });
    console.log(`\n  活跃邀请任务 (PENDING/RUNNING): ${activeTasks.length} 条`);

    // Calculation check
    const NON_ADMIN_CAPACITY = 5;
    const actualNonRemovedCount = active.length + pending.length;
    const correctAvailableSlots = Math.max(0, NON_ADMIN_CAPACITY - actualNonRemovedCount);
    console.log(`\n  ── 诊断 ──`);
    console.log(`  实际非移除成员数 (ACTIVE+PENDING): ${actualNonRemovedCount}`);
    console.log(`  应有 availableSlots: ${correctAvailableSlots}`);
    console.log(`  数据库 availableSlots: ${group.availableSlots}`);
    console.log(`  数据库 pendingInviteCount: ${group.pendingInviteCount}`);
    console.log(`  是否需要修正: ${correctAvailableSlots !== group.availableSlots ? '✅ 是' : '❌ 否'}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
