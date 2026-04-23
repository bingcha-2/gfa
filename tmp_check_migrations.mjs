import { createRequire } from 'module';
import { PrismaClient } from '@prisma/client';

// Resolve bcrypt from the api app where it's a direct dependency
const require = createRequire(new URL('file:///C:/Users/Administrator/Desktop/GFA/apps/api/'));
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();
const newPassword = 'admin123';
const hash = await bcrypt.hash(newPassword, 10);

await prisma.user.update({
  where: { email: 'admin@gfa.local' },
  data: { passwordHash: hash }
});

console.log('✅ Password reset for admin@gfa.local');
console.log('   New password: admin123');
await prisma.$disconnect();
