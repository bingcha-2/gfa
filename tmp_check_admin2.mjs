import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const allUsers = await prisma.user.findMany();
  console.log('=== 所有后台用户 ===');
  for (const u of allUsers) {
    console.log(`  email: ${u.email}, role: ${u.role}, displayName: ${u.displayName}, passwordHash长度: ${u.passwordHash?.length || 0}`);
  }

  const admin2 = await prisma.user.findUnique({ where: { email: 'admin2@gmail.com' } });
  console.log('\n=== admin2@gmail.com 详情 ===');
  console.log(JSON.stringify(admin2, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
