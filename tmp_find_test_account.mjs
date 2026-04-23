import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// List ALL accounts and their profiles
const accounts = await p.account.findMany({
  select: {
    id: true,
    loginEmail: true,
    adspowerProfileId: true,
    status: true,
  },
  take: 20
});

for (const a of accounts) {
  console.log(`${a.loginEmail} | profile=${a.adspowerProfileId} | status=${a.status}`);
}

console.log(`\nTotal: ${accounts.length} accounts`);

await p.$disconnect();
