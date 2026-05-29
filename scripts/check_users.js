const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        passwordHash: true,
        permissions: true,
        createdAt: true,
        updatedAt: true,
      }
    });
    
    console.log(`\nFound ${users.length} user(s) in database:\n`);
    
    for (const user of users) {
      console.log(`  ID: ${user.id}`);
      console.log(`  Email: ${user.email}`);
      console.log(`  Display Name: ${user.displayName}`);
      console.log(`  Role: ${user.role}`);
      console.log(`  Password Hash: ${user.passwordHash.substring(0, 20)}...`);
      console.log(`  Hash starts with $2: ${user.passwordHash.startsWith('$2')}`);
      console.log(`  Hash length: ${user.passwordHash.length}`);
      console.log(`  Permissions: ${user.permissions}`);
      console.log(`  Created: ${user.createdAt}`);
      console.log(`  Updated: ${user.updatedAt}`);
      console.log('  ---');
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
