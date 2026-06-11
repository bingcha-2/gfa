const { PrismaClient } = require('@prisma/client');
const bcrypt = require(require.resolve('bcrypt', { paths: [__dirname + '/../apps/server'] }));

const prisma = new PrismaClient();

async function main() {
  const email = 'test1@gfa.local';
  const newPassword = 'Test123456';
  
  const hash = await bcrypt.hash(newPassword, 10);
  
  const user = await prisma.user.update({
    where: { email },
    data: { passwordHash: hash },
    select: { id: true, email: true, displayName: true, role: true }
  });
  
  console.log('✅ Password reset successful!');
  console.log(`  Email: ${user.email}`);
  console.log(`  Display Name: ${user.displayName}`);
  console.log(`  Role: ${user.role}`);
  console.log(`  New Password: ${newPassword}`);
  
  await prisma.$disconnect();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
