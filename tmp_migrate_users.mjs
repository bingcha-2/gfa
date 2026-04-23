// Data migration: upgrade admin@gfa.local to SUPER_ADMIN, delete test users
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // 1. Upgrade admin@gfa.local to SUPER_ADMIN
  const admin = await p.user.update({
    where: { email: 'admin@gfa.local' },
    data: { role: 'SUPER_ADMIN' },
  });
  console.log(`Upgraded ${admin.email} to ${admin.role}`);

  // 2. Delete support@gfa.local
  try {
    await p.user.delete({ where: { email: 'support@gfa.local' } });
    console.log('Deleted support@gfa.local');
  } catch { console.log('support@gfa.local not found, skipping'); }

  // 3. Delete test1@gfa.local
  try {
    await p.user.delete({ where: { email: 'test1@gfa.local' } });
    console.log('Deleted test1@gfa.local');
  } catch { console.log('test1@gfa.local not found, skipping'); }

  // 4. Verify
  const users = await p.user.findMany({ select: { email: true, role: true, displayName: true } });
  console.log('\nRemaining users:', JSON.stringify(users, null, 2));
}

main().catch(console.error).finally(() => p.$disconnect());
