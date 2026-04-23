import fs from 'fs';
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const result = {};

// 1. Current slot summary
const groups = await p.familyGroup.findMany({
  where: { status: 'ACTIVE' },
  select: {
    id: true, groupName: true, memberCount: true, availableSlots: true, maxMembers: true,
    pendingInviteCount: true,
    account: { select: { loginEmail: true, status: true } },
    _count: { select: { members: true } }
  }
});
result.totalGroups = groups.length;
result.totalSlots = groups.reduce((s, g) => s + g.availableSlots, 0);
result.totalMembers = groups.reduce((s, g) => s + g.memberCount, 0);
result.totalPendingInvites = groups.reduce((s, g) => s + g.pendingInviteCount, 0);

// 2. Today's tasks (orders, invites, replacements, removals)
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);

const todayTasks = await p.task.findMany({
  where: { createdAt: { gte: todayStart } },
  select: { id: true, type: true, status: true, createdAt: true, payload: true },
  orderBy: { createdAt: 'asc' }
});

const tasksByType = {};
for (const t of todayTasks) {
  if (!tasksByType[t.type]) tasksByType[t.type] = { total: 0, statuses: {} };
  tasksByType[t.type].total++;
  tasksByType[t.type].statuses[t.status] = (tasksByType[t.type].statuses[t.status] || 0) + 1;
}
result.todayTasksByType = tasksByType;

// 3. Today's orders
const todayOrders = await p.order.findMany({
  where: { createdAt: { gte: todayStart } },
  select: { id: true, orderNo: true, orderType: true, status: true, userEmail: true, createdAt: true }
});

const ordersByType = {};
for (const o of todayOrders) {
  const t = o.orderType || 'UNKNOWN';
  if (!ordersByType[t]) ordersByType[t] = { total: 0, statuses: {} };
  ordersByType[t].total++;
  ordersByType[t].statuses[o.status] = (ordersByType[t].statuses[o.status] || 0) + 1;
}
result.todayOrdersByType = ordersByType;
result.todayOrdersCount = todayOrders.length;

// 4. Today's new members (invites sent today)
const todayMembers = await p.familyMember.findMany({
  where: { createdAt: { gte: todayStart } },
  select: { id: true, email: true, status: true, familyGroupId: true, createdAt: true }
});
result.todayNewMembers = todayMembers.length;
const membersByStatus = {};
for (const m of todayMembers) {
  membersByStatus[m.status] = (membersByStatus[m.status] || 0) + 1;
}
result.todayMembersByStatus = membersByStatus;

// 5. Today's removed members
const todayRemoved = await p.familyMember.findMany({
  where: { removedAt: { gte: todayStart }, status: 'REMOVED' },
  select: { id: true, email: true, familyGroupId: true }
});
result.todayRemovedMembers = todayRemoved.length;

// 6. Today's invites
const todayInvites = await p.familyInvite.findMany({
  where: { createdAt: { gte: todayStart } },
  select: { id: true, email: true, status: true, familyGroupId: true }
});
const invitesByStatus = {};
for (const inv of todayInvites) {
  invitesByStatus[inv.status] = (invitesByStatus[inv.status] || 0) + 1;
}
result.todayInvites = todayInvites.length;
result.todayInvitesByStatus = invitesByStatus;

// 7. Groups with 0 available slots
const fullGroups = groups.filter(g => g.availableSlots === 0);
result.fullGroups = fullGroups.length;

// 8. Groups with available slots breakdown
const slotDistribution = {};
for (const g of groups) {
  const key = `${g.availableSlots} slots`;
  slotDistribution[key] = (slotDistribution[key] || 0) + 1;
}
result.slotDistribution = slotDistribution;

// 9. Net seat change analysis: members added today - members removed today
result.netSeatChange = result.todayRemovedMembers - result.todayNewMembers;

// 10. PENDING members across all groups (occupying slots but not yet accepted)
const pendingMembers = await p.familyMember.count({
  where: { status: 'PENDING' }
});
result.totalPendingMembers = pendingMembers;

// 11. Today's redeem code usage
const todayUsedCodes = await p.redeemCode.count({
  where: { usedAt: { gte: todayStart } }
});
result.todayUsedCodes = todayUsedCodes;

fs.writeFileSync('tmp_seat_analysis.json', JSON.stringify(result, null, 2));
console.log('Analysis written to tmp_seat_analysis.json');
await p.$disconnect();
