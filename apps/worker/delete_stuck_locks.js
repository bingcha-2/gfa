const Redis = require('ioredis');

async function main() {
  const redis = new Redis('redis://localhost:6379');
  
  const locks = [
    'bull:automation-queue:automation-cmpppdecy0006xkgw1jftv0yj:lock',
    'bull:automation-queue:automation-cmpppdemb0007xkgwhoyawvpw:lock'
  ];
  
  console.log('=== Deleting Stuck BullMQ Job Locks ===');
  for (const lock of locks) {
    const exists = await redis.exists(lock);
    if (exists) {
      const val = await redis.get(lock);
      console.log(`Lock ${lock} exists (held by ${val}). Deleting...`);
      await redis.del(lock);
      console.log(`Deleted ${lock}`);
    } else {
      console.log(`Lock ${lock} does not exist.`);
    }
  }
  
  await redis.disconnect();
}

main().catch(console.error);
