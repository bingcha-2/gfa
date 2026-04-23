// tmp_check_order.cjs - Query order by ID using Prisma
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TARGET_ID = 'cmnndp8m1000';

async function main() {
  // Try by id first, then prefix match
  let order = await prisma.order.findUnique({
    where: { id: TARGET_ID },
    include: {
      tasks: { include: { logs: true }, orderBy: { createdAt: 'desc' } },
      swapRecords: { orderBy: { createdAt: 'desc' } },
      familyGroup: { include: { members: { where: { status: { in: ['ACTIVE', 'PENDING'] } } } } },
      redeemCode: true
    }
  });

  if (!order) {
    // Try prefix match
    const candidates = await prisma.order.findMany({
      where: { id: { startsWith: TARGET_ID } },
      include: {
        tasks: { include: { logs: true }, orderBy: { createdAt: 'desc' } },
        swapRecords: { orderBy: { createdAt: 'desc' } },
        familyGroup: { include: { members: { where: { status: { in: ['ACTIVE', 'PENDING'] } } } } },
        redeemCode: true
      }
    });
    if (candidates.length > 0) order = candidates[0];
  }

  if (!order) {
    console.log('Order not found for ID:', TARGET_ID);
    return;
  }

  console.log('=== ORDER ===');
  console.log('ID:', order.id);
  console.log('Order No:', order.orderNo);
  console.log('Type:', order.orderType);
  console.log('Status:', order.status);
  console.log('User Email:', order.userEmail);
  console.log('Result Message:', order.resultMessage);
  console.log('Family Group ID:', order.familyGroupId);
  console.log('Redeem Code ID:', order.redeemCodeId);
  console.log('Assigned At:', order.assignedAt);
  console.log('Expires At:', order.expiresAt);
  console.log('Swap Count:', order.swapCount);
  console.log('Last Swap At:', order.lastSwapAt);
  console.log('Created At:', order.createdAt);
  console.log('Updated At:', order.updatedAt);

  if (order.redeemCode) {
    console.log('\n=== REDEEM CODE ===');
    console.log('Code:', order.redeemCode.code);
    console.log('Type:', order.redeemCode.codeType);
    console.log('Status:', order.redeemCode.status);
    console.log('Used At:', order.redeemCode.usedAt);
  }

  if (order.familyGroup) {
    console.log('\n=== FAMILY GROUP ===');
    console.log('ID:', order.familyGroup.id);
    console.log('Group Name:', order.familyGroup.groupName);
    console.log('Status:', order.familyGroup.status);
    console.log('Member Count:', order.familyGroup.memberCount);
    console.log('Available Slots:', order.familyGroup.availableSlots);
    console.log('Pending Invite Count:', order.familyGroup.pendingInviteCount);
    
    // Check if user email is in active members
    const activeMembers = order.familyGroup.members || [];
    const userMember = activeMembers.find(m => m.email.toLowerCase() === order.userEmail.toLowerCase());
    console.log('\n--- Active/Pending Members ---');
    for (const m of activeMembers) {
      const isTarget = m.email.toLowerCase() === order.userEmail.toLowerCase();
      console.log(`  ${isTarget ? '>>> ' : '    '}${m.email} | Status: ${m.status} | Role: ${m.role} | Joined: ${m.joinedAt} | Expires: ${m.expiresAt}`);
    }
    if (!userMember) {
      console.log(`  !!! User email ${order.userEmail} NOT found in active members`);
    }
  }

  console.log(`\n=== TASKS (${order.tasks.length}) ===`);
  for (const t of order.tasks) {
    console.log(`\nTask ID: ${t.id}`);
    console.log(`  Type: ${t.type} | Status: ${t.status}`);
    console.log(`  Retry: ${t.retryCount}/${t.maxRetryCount}`);
    console.log(`  Error Code: ${t.lastErrorCode}`);
    console.log(`  Error Msg: ${t.lastErrorMessage}`);
    console.log(`  Started: ${t.startedAt} | Finished: ${t.finishedAt}`);
    console.log(`  Created: ${t.createdAt}`);
    
    const payload = JSON.parse(t.payload || '{}');
    console.log(`  Payload:`, JSON.stringify(payload, null, 4));

    if (t.logs.length > 0) {
      console.log(`  --- Logs (${t.logs.length}) ---`);
      for (const l of t.logs) {
        console.log(`    [${l.createdAt.toISOString()}] [${l.level}] ${l.message}`);
        if (l.extra) console.log(`      Extra: ${l.extra.substring(0, 200)}`);
      }
    }
  }

  if (order.swapRecords.length > 0) {
    console.log(`\n=== SWAP RECORDS (${order.swapRecords.length}) ===`);
    for (const sr of order.swapRecords) {
      console.log(`  ${sr.id} | ${sr.status} | ${sr.oldEmail} -> ${sr.newEmail} | Task: ${sr.taskId} | Created: ${sr.createdAt}`);
    }
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
