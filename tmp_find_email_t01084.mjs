import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const email = 't01084031224@gmail.com';
  console.log(`\n=== 查询邮箱: ${email} ===\n`);

  const members = await prisma.familyMember.findMany({ where: { email }, include: { familyGroup: { select: { account: { select: { loginEmail: true } } } } } });
  console.log('【FamilyMember 表】:', JSON.stringify(members, null, 2));

  const invites = await prisma.familyInvite.findMany({ where: { email } });
  console.log('\n【FamilyInvite 表】:', JSON.stringify(invites, null, 2));

  const orders = await prisma.order.findMany({ where: { memberEmail: email } });
  console.log('\n【Order 表】:', JSON.stringify(orders, null, 2));

  const accounts = await prisma.account.findMany({ where: { loginEmail: email } });
  console.log('\n【Account 表】:', JSON.stringify(accounts, null, 2));

  const swaps = await prisma.swapRecord.findMany({ where: { newUserEmail: email } });
  console.log('\n【SwapRecord 表】:', JSON.stringify(swaps, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
