import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import Redis from 'ioredis';

const p = new PrismaClient();
const redis = new Redis('redis://localhost:6379');
const lines = [];
function log(s) { lines.push(s); }

// The dedup jobId that bulkInvite creates:
const familyGroupId = 'cmnikt6fv00g6xkh4u71dps4y';
const email = 'gvc99774@gmail.com';
const dedupJobId = `invite:${familyGroupId}:${email}`;
log(`=== Checking BullMQ dedup key ===`);
log(`Expected jobId: ${dedupJobId}`);

// BullMQ stores jobs in Redis sorted sets, keyed by queue name.
// The dedup key prevents adding a job with the same jobId while one already exists.
// This is the critical issue: if the FIRST invite (cmnj2s17800p7xk8svuqu67rm) from April 3
// still has a BullMQ job in the completed set with jobId `invite:${groupId}:${email}`,
// then the SECOND add() call on April 4 would silently be rejected.

// Check BullMQ internal keys
const queueName = 'family-invite-queue';
const prefix = 'bull';

// List all keys for the invite queue
const keys = await redis.keys(`${prefix}:${queueName}:*`);
log(`\nRedis keys for invite queue: ${keys.length} total`);

// Check the specific job ID
const jobKey = `${prefix}:${queueName}:${dedupJobId}`;
const jobExists = await redis.exists(jobKey);
log(`\nJob key '${jobKey}' exists: ${jobExists}`);

// Check completed and failed sets for this jobId
const completedKey = `${prefix}:${queueName}:completed`;
const failedKey = `${prefix}:${queueName}:failed`;

// BullMQ uses the jobId as the member in the sorted set
const inCompleted = await redis.zscore(completedKey, dedupJobId);
const inFailed = await redis.zscore(failedKey, dedupJobId);
log(`In completed set: ${inCompleted !== null ? `YES (score: ${inCompleted})` : 'NO'}`);
log(`In failed set: ${inFailed !== null ? `YES (score: ${inFailed})` : 'NO'}`);

// Check the hash data for this job
const jobHash = await redis.hgetall(`${prefix}:${queueName}:${dedupJobId}`);
if (Object.keys(jobHash).length > 0) {
  log(`\nJob hash data:`);
  for (const [k, v] of Object.entries(jobHash)) {
    log(`  ${k}: ${v?.slice(0, 200)}`);
  }
} else {
  log(`\nNo hash data found for jobId ${dedupJobId}`);
}

// Also check what JOB_DEFAULTS says about removeOnComplete
log(`\nJOB_DEFAULTS.removeOnComplete: { count: 100 }`);
log(`JOB_DEFAULTS.removeOnFail: { count: 500 }`);
log(`\nThis means BullMQ keeps the last 100 completed jobs.`);
log(`If the previous invite job (April 3) is still in the completed set,`);
log(`BullMQ will SILENTLY refuse to add a new job with the same jobId.`);
log(`queue.add() does NOT throw on dedup collision - it just returns the existing job.`);

// Let's check how many completed jobs exist
const completedCount = await redis.zcard(completedKey);
log(`\nTotal completed jobs in invite queue: ${completedCount}`);

// Check the most recent completed jobs  
const recentCompleted = await redis.zrange(completedKey, -10, -1, 'WITHSCORES');
log(`\nLast 10 completed job IDs:`);
for (let i = 0; i < recentCompleted.length; i += 2) {
  const jobId = recentCompleted[i];
  const score = recentCompleted[i + 1];
  const ts = new Date(parseInt(score)).toISOString();
  log(`  ${jobId} (completed at: ${ts})`);
}

await p.$disconnect();
await redis.quit();
writeFileSync('tmp_redis_investigation.txt', lines.join('\n'));
console.log('Done! See tmp_redis_investigation.txt');
