const Redis = require('ioredis');

async function main() {
  const redis = new Redis('redis://localhost:6379');
  
  const familyGroupId = 'cmnikt6fv00g6xkh4u71dps4y';
  const email = 'gvc99774@gmail.com';
  const dedupJobId = `invite:${familyGroupId}:${email}`;
  
  console.log(`=== Checking BullMQ dedup for jobId: ${dedupJobId} ===`);
  
  const queueName = 'family-invite-queue';
  const prefix = 'bull';
  
  // Check if the job hash exists
  const jobHash = await redis.hgetall(`${prefix}:${queueName}:${dedupJobId}`);
  console.log(`\nJob hash exists: ${Object.keys(jobHash).length > 0}`);
  if (Object.keys(jobHash).length > 0) {
    for (const [k, v] of Object.entries(jobHash)) {
      console.log(`  ${k}: ${String(v).slice(0, 200)}`);
    }
  }
  
  // Check in completed set
  const completedKey = `${prefix}:${queueName}:completed`;
  const inCompleted = await redis.zscore(completedKey, dedupJobId);
  console.log(`\nIn completed set: ${inCompleted !== null ? `YES (ts: ${inCompleted})` : 'NO'}`);
  
  // Check in failed set
  const failedKey = `${prefix}:${queueName}:failed`;
  const inFailed = await redis.zscore(failedKey, dedupJobId);
  console.log(`In failed set: ${inFailed !== null ? `YES (ts: ${inFailed})` : 'NO'}`);
  
  // Total completed count
  const completedCount = await redis.zcard(completedKey);
  console.log(`\nTotal completed jobs in invite queue: ${completedCount}`);
  
  // Find invite: prefixed jobs in completed set  
  const allCompleted = await redis.zrange(completedKey, 0, -1);
  const inviteDedup = allCompleted.filter(id => id.startsWith('invite:'));
  console.log(`\nCompleted jobs with 'invite:' dedup key: ${inviteDedup.length}`);
  for (const j of inviteDedup.slice(0, 20)) {
    const score = await redis.zscore(completedKey, j);
    const ts = score ? new Date(parseInt(score)).toISOString() : '?';
    console.log(`  ${j} (completed: ${ts})`);
  }
  
  // Also check in ALL sets (waiting, active, delayed, failed)
  const waitKey = `${prefix}:${queueName}:wait`;
  const activeKey = `${prefix}:${queueName}:active`;
  const delayedKey = `${prefix}:${queueName}:delayed`;
  
  const waitLen = await redis.llen(waitKey);
  const activeLen = await redis.llen(activeKey);
  const delayedLen = await redis.zcard(delayedKey);
  const failedLen = await redis.zcard(failedKey);
  
  console.log(`\n=== Queue Status ===`);
  console.log(`Waiting: ${waitLen}`);
  console.log(`Active: ${activeLen}`);
  console.log(`Delayed: ${delayedLen}`);
  console.log(`Completed: ${completedCount}`);
  console.log(`Failed: ${failedLen}`);
  
  await redis.quit();
}

main().catch(e => { console.error(e); process.exit(1); });
