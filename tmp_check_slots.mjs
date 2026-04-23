import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const redis = new Redis();

async function main() {
  const accounts = await prisma.account.findMany({
    where: { loginEmail: 'MikerlangeMariza@gmail.com' },
    include: { familyGroups: true }
  });
  
  if (accounts.length === 0) {
    console.log("Account MikerlangeMariza@gmail.com not found in DB.");
  } else {
    const acc = accounts[0];
    console.log(`Account ID: ${acc.id}, Status: ${acc.status}`);
    
    const failures = await redis.get(`gfa:account-failures:${acc.id}`);
    const cooldown = await redis.pttl(`gfa:login-cooldown:${acc.id}`);
    console.log(`Redis failures: ${failures}, Cooldown TTL: ${cooldown}ms`);
    
    for (const fg of acc.familyGroups) {
      console.log(`Family Group: ${fg.id}, Status: ${fg.status}, availableSlots: ${fg.availableSlots}`);
    }
  }
  
  // Also check how many total candidates there are right now
  const candidates = await prisma.familyGroup.findMany({
    where: {
      status: "ACTIVE",
      availableSlots: { gt: 0 },
      account: { status: "HEALTHY" },
    },
    select: { id: true, accountId: true },
  });
  console.log(`\nTotal candidate family groups (ACTIVE, health, >0 slots) in DB: ${candidates.length}`);
  
  let trulyAvailable = 0;
  for (const c of candidates) {
    const cd = await redis.pttl(`gfa:login-cooldown:${c.accountId}`);
    const f = await redis.get(`gfa:account-failures:${c.accountId}`);
    if (cd <= 0 && (!f || parseInt(f) < 3)) {
      trulyAvailable++;
    }
  }
  console.log(`Total TRULY available candidates (not in cooldown, <3 failures): ${trulyAvailable}`);
}
main().catch(console.error).finally(() => { prisma.$disconnect(); redis.disconnect(); });
