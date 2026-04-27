const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const account = await p.account.findUnique({
    where: { loginEmail: 'bernardteofano@gmail.com' },
    include: {
      familyGroups: {
        include: {
          members: {
            where: { status: 'PENDING' }
          }
        }
      }
    }
  });
  console.log(JSON.stringify(account.familyGroups, null, 2));
  await p.$disconnect();
})();
