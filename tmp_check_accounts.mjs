import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const accounts = await p.account.findMany({
  select: {
    id: true,
    loginEmail: true,
    loginPassword: true,
    totpSecret: true,
    status: true,
  },
  take: 20,
});

console.log(`Total accounts in DB: ${accounts.length}+`);
console.log('');
for (const a of accounts) {
  const hasPwd = a.loginPassword ? `YES (${a.loginPassword.length} chars)` : 'NO';
  const hasTotp = a.totpSecret ? 'YES' : 'NO';
  console.log(`  ${a.loginEmail}`);
  console.log(`    password: ${hasPwd}  |  totp: ${hasTotp}  |  status: ${a.status}`);
}

const total = await p.account.count();
const withPwd = await p.account.count({ where: { loginPassword: { not: null } } });
const withTotp = await p.account.count({ where: { totpSecret: { not: null } } });
console.log(`\n--- Summary ---`);
console.log(`Total accounts: ${total}`);
console.log(`With password:  ${withPwd}`);
console.log(`With TOTP:      ${withTotp}`);
console.log(`Can do OAuth:   ${withPwd} (need password to login)`);

await p.$disconnect();
