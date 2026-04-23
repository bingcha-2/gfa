import { PrismaClient } from './node_modules/.prisma/client/index.js';
const p = new PrismaClient();

const email = 'lucianovelvet2@gmail.com';

const members = await p.familyMember.findMany({
  where: { email: { contains: 'lucianovelvet2' } },
  include: { familyGroup: { select: { id: true, groupName: true, accountId: true } } }
});
console.log('=== FamilyMember ===');
for (const m of members) {
  console.log(`  email: ${m.email}`);
  console.log(`  status: ${m.status}`);
  console.log(`  expiresAt: ${m.expiresAt}`);
  console.log(`  joinedAt: ${m.joinedAt}`);
  console.log(`  familyGroupId: ${m.familyGroupId}`);
  console.log(`  group: ${m.familyGroup?.groupName}`);
  console.log('---');
}

const orders = await p.order.findMany({
  where: { userEmail: { contains: 'lucianovelvet2' } },
  include: {
    redeemCode: { select: { id: true, code: true, codeType: true, expiresAt: true, validDays: true } }
  },
  orderBy: { createdAt: 'desc' }
});
console.log('\n=== Orders ===');
for (const o of orders) {
  console.log(`  orderNo: ${o.orderNo}`);
  console.log(`  orderType: ${o.orderType}`);
  console.log(`  status: ${o.status}`);
  console.log(`  expiresAt: ${o.expiresAt}`);
  console.log(`  familyGroupId: ${o.familyGroupId}`);
  console.log(`  redeemCode: ${o.redeemCode?.code} (type: ${o.redeemCode?.codeType}, expires: ${o.redeemCode?.expiresAt}, validDays: ${o.redeemCode?.validDays})`);
  console.log(`  createdAt: ${o.createdAt}`);
  console.log(`  updatedAt: ${o.updatedAt}`);
  console.log('---');
}

await p.$disconnect();
