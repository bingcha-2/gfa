const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const account = await prisma.agentAccount.findFirst({
    where: { loginEmail: '4to1raliceo9tm@gmail.com' }
  });
  console.log(JSON.stringify(account, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
