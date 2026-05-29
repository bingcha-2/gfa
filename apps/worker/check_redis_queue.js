const Redis = require('ioredis');

const QUEUE_NAMES = {
  invite: "family-invite-queue",
  remove: "family-remove-queue",
  replace: "family-replace-queue",
  sync: "family-sync-queue",
  health: "account-health-queue",
  retry: "manual-retry-queue",
  automation: "automation-queue"
};

async function main() {
  const redis = new Redis('redis://localhost:6379');
  
  console.log('=== Redis Connection Health ===');
  const ping = await redis.ping();
  console.log('Ping:', ping);
  
  const keys = await redis.keys('*');
  console.log('Total keys in Redis:', keys.length);
  
  console.log('\n=== BullMQ Queue Status ===');
  
  for (const [key, q] of Object.entries(QUEUE_NAMES)) {
    const active = await redis.llen(`bull:${q}:active`);
    const wait = await redis.llen(`bull:${q}:wait`);
    const delayed = await redis.zcard(`bull:${q}:delayed`);
    const paused = await redis.llen(`bull:${q}:paused`);
    const completed = await redis.zcard(`bull:${q}:completed`);
    const failed = await redis.zcard(`bull:${q}:failed`);
    
    console.log(`Queue: ${q.padEnd(22)} | Wait: ${wait} | Active: ${active} | Delayed: ${delayed} | Paused: ${paused} | Completed: ${completed} | Failed: ${failed}`);
  }
  
  console.log('\n=== Profile Locks ===');
  const locks = await redis.keys('gfa:pool:profile:*');
  console.log(`Found ${locks.length} active profile locks:`);
  for (const lock of locks) {
    const val = await redis.get(lock);
    const ttl = await redis.ttl(lock);
    console.log(`  Lock: ${lock} | Owner: ${val} | TTL: ${ttl}s`);
  }
  
  console.log('\n=== Account Locks ===');
  const accLocks = await redis.keys('gfa:pool:account:*');
  console.log(`Found ${accLocks.length} active account locks:`);
  for (const lock of accLocks) {
    const val = await redis.get(lock);
    const ttl = await redis.ttl(lock);
    console.log(`  Lock: ${lock} | Owner: ${val} | TTL: ${ttl}s`);
  }

  await redis.disconnect();
}

main().catch(console.error);
