import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const email = 't01091395490@gmail.com';
  console.log(`\n=== 数据库查询: ${email} ===\n`);

  const members = await prisma.familyMember.findMany({ where: { email }, include: { familyGroup: { select: { account: { select: { loginEmail: true } } } } } });
  console.log('【FamilyMember 表】(家庭组成员记录):');
  console.log(JSON.stringify(members, null, 2));

  const invites = await prisma.familyInvite.findMany({ where: { email } });
  console.log('\n【FamilyInvite 表】(邀请发件记录):');
  console.log(JSON.stringify(invites, null, 2));

  const orders = await prisma.order.findMany({ where: { memberEmail: email } });
  console.log('\n【Order 表】(相关订单记录):');
  console.log(JSON.stringify(orders, null, 2));

  const swapRecordsConfigured = await prisma.swapRecord.findMany({ where: { newUserEmail: email } });
  console.log('\n【SwapRecord 表】(换号记录新成员 - 如果有):');
  console.log(JSON.stringify(swapRecordsConfigured, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
