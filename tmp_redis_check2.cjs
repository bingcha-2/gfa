const Redis = require('ioredis');

async function main() {
  const redis = new Redis('redis://localhost:6379');

  const familyGroupId = 'cmnikt6fv00g6xkh4u71dps4y';
  const email = 'gvc99774@gmail.com';
  const dedupJobId = `invite:${familyGroupId}:${email}`;
  const queueName = 'family-invite-queue';
  const prefix = 'bull';

  console.log(`=== Checking BullMQ dedup key ===`);
  console.log(`Expected jobId: ${dedupJobId}`);

  // Check if the job hash exists
  const jobHash = await redis.hgetall(`${prefix}:${queueName}:${dedupJobId}`);
  if (Object.keys(jobHash).length > 0) {
    console.log(`\nJob hash data FOUND:`);
    for (const [k, v] of Object.entries(jobHash)) {
      console.log(`  ${k}: ${String(v).slice(0, 200)}`);
    }
  } else {
    console.log(`\nNo active hash data for jobId ${dedupJobId}`);
  }

  // Check completed and failed sets
  const completedKey = `${prefix}:${queueName}:completed`;
  const failedKey = `${prefix}:${queueName}:failed`;

  const inCompleted = await redis.zscore(completedKey, dedupJobId);
  const inFailed = await redis.zscore(failedKey, dedupJobId);
  console.log(`\nIn completed set: ${inCompleted !== null ? `YES (score: ${inCompleted}, ts: ${new Date(parseInt(inCompleted)).toISOString()})` : 'NO'}`);
  console.log(`In failed set: ${inFailed !== null ? `YES (score: ${inFailed})` : 'NO'}`);

  // Count total completed jobs
  const completedCount = await redis.zcard(completedKey);
  console.log(`\nTotal completed jobs in invite queue: ${completedCount}`);

  // Last 20 completed jobs
  const recentCompleted = await redis.zrange(completedKey, -20, -1, 'WITHSCORES');
  console.log(`\nLast 20 completed job IDs:`);
  for (let i = 0; i < recentCompleted.length; i += 2) {
    const jobId = recentCompleted[i];
    const score = recentCompleted[i + 1];
    const ts = new Date(parseInt(score)).toISOString();
    console.log(`  ${jobId} (completed at: ${ts})`);
  }

  // Also check waiting jobs
  const waitingKey = `${prefix}:${queueName}:wait`;
  const waitingJobs = await redis.lrange(waitingKey, 0, -1);
  console.log(`\nWaiting jobs: ${waitingJobs.length}`);
  waitingJobs.forEach(j => console.log(`  ${j}`));

  // Check active jobs
  const activeKey = `${prefix}:${queueName}:active`;
  const activeJobs = await redis.lrange(activeKey, 0, -1);
  console.log(`\nActive jobs: ${activeJobs.length}`);
  activeJobs.forEach(j => console.log(`  ${j}`));

  // Check delayed jobs
  const delayedKey = `${prefix}:${queueName}:delayed`;
  const delayedJobs = await redis.zrange(delayedKey, 0, -1, 'WITHSCORES');
  console.log(`\nDelayed jobs: ${delayedJobs.length / 2}`);
  for (let i = 0; i < delayedJobs.length; i += 2) {
    console.log(`  ${delayedJobs[i]} (delayed until: ${new Date(parseInt(delayedJobs[i + 1])).toISOString()})`);
  }

  // Check if the original invite for this email is still in completed set 
  // from a previous bulkInvite call (before the REMOVE + re-INVITE flow)
  const allCompletedWithScores = await redis.zrange(completedKey, 0, -1, 'WITHSCORES');
  const matchingJobs = [];
  for (let i = 0; i < allCompletedWithScores.length; i += 2) {
    if (allCompletedWithScores[i].includes(email) || allCompletedWithScores[i].includes(familyGroupId)) {
      matchingJobs.push({ id: allCompletedWithScores[i], ts: new Date(parseInt(allCompletedWithScores[i + 1])).toISOString() });
    }
  }
  console.log(`\nMatching completed jobs for email/group: ${matchingJobs.length}`);
  matchingJobs.forEach(j => console.log(`  ${j.id} (${j.ts})`));

  // Check failed set for matching
  const allFailedWithScores = await redis.zrange(failedKey, 0, -1, 'WITHSCORES');
  const matchingFailed = [];
  for (let i = 0; i < allFailedWithScores.length; i += 2) {
    if (allFailedWithScores[i].includes(email) || allFailedWithScores[i].includes(familyGroupId)) {
      matchingFailed.push({ id: allFailedWithScores[i], ts: new Date(parseInt(allFailedWithScores[i + 1])).toISOString() });
    }
  }
  console.log(`\nMatching failed jobs for email/group: ${matchingFailed.length}`);
  matchingFailed.forEach(j => console.log(`  ${j.id} (${j.ts})`));

  await redis.quit();
}

main().catch(console.error);
