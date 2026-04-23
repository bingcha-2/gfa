import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const users = await p.user.findMany({
  select: { id: true, email: true, displayName: true, role: true, permissions: true }
});
console.log(JSON.stringify(users, null, 2));
await p.$disconnect();
