const Redis = require('ioredis');

async function main() {
  const redis = new Redis('redis://localhost:6379');

  const prefix = 'bull';
  const qn = 'family-invite-queue';
  const taskId = 'cmnkdxjr6002axkastwwexiud';
  const fgId = 'cmnikt6fv00g6xkh4u71dps4y';
  const email = 'gvc99774@gmail.com';

  // The bulkInvite path uses this dedup key:
  const dedupJobId = `invite:${fgId}:${email}`;
  
  console.log('=== Deep investigation for task', taskId, '===');
  console.log('Expected BullMQ jobId:', dedupJobId);
  console.log();

  // 1. Check if ANY invite for this specific FG+email ever existed
  const allKeys = await redis.keys(`${prefix}:${qn}:invite:${fgId}:*`);
  console.log(`Redis keys matching invite:${fgId}:* = ${allKeys.length}`);
  for (const k of allKeys) {
    console.log(`  ${k}`);
  }
  
  // 2. Check if the job hash for this specific dedup key ever existed
  const jobHash = await redis.hgetall(`${prefix}:${qn}:${dedupJobId}`);
  console.log(`\nJob hash ${dedupJobId}: ${Object.keys(jobHash).length > 0 ? 'EXISTS' : 'NOT FOUND'}`);
  if (Object.keys(jobHash).length > 0) {
    for (const [k, v] of Object.entries(jobHash)) {
      console.log(`  ${k}: ${String(v).slice(0, 300)}`);
    }
  }

  // 3. Check ALL sets for this dedup key
  const sets = ['completed', 'failed', 'waiting-children'];
  for (const setName of sets) {
    const key = `${prefix}:${qn}:${setName}`;
    const score = await redis.zscore(key, dedupJobId);
    console.log(`In ${setName}: ${score !== null ? `YES (${new Date(parseInt(score)).toISOString()})` : 'NO'}`);
  }

  // 4. Check waiting list
  const waitKey = `${prefix}:${qn}:wait`;
  const waitList = await redis.lrange(waitKey, 0, -1);
  const inWait = waitList.includes(dedupJobId);
  console.log(`In wait list: ${inWait}`);

  // 5. Check active list
  const activeKey = `${prefix}:${qn}:active`;
  const activeList = await redis.lrange(activeKey, 0, -1);
  const inActive = activeList.includes(dedupJobId);
  console.log(`In active list: ${inActive}`);

  // 6. Check delayed set
  const delayedKey = `${prefix}:${qn}:delayed`;
  const delayedScore = await redis.zscore(delayedKey, dedupJobId);
  console.log(`In delayed set: ${delayedScore !== null ? `YES (${new Date(parseInt(delayedScore)).toISOString()})` : 'NO'}`);

  // 7. Now check if there was a PREVIOUS invite for this FG+email that was still
  //    in BullMQ's internal state when the new one was added.
  //    The key question: was the FIRST invite for gvc99774@gmail.com in FG cmnikt6fv00g6xkh4u71dps4y
  //    still present in completed/failed set when the second invite was attempted?
  
  // Look at ALL completed set entries sorted by time
  const allComp = await redis.zrange(`${prefix}:${qn}:completed`, 0, -1, 'WITHSCORES');
  console.log(`\n=== All completed jobs referencing gvc99774 ===`);
  for (let i = 0; i < allComp.length; i += 2) {
    if (allComp[i].includes('gvc99774')) {
      console.log(`  ${allComp[i]} (${new Date(parseInt(allComp[i+1])).toISOString()})`);
    }
  }

  // 8. Check failed set for gvc99774
  const allFail = await redis.zrange(`${prefix}:${qn}:failed`, 0, -1, 'WITHSCORES');
  console.log(`\n=== All failed jobs referencing gvc99774 ===`);
  for (let i = 0; i < allFail.length; i += 2) {
    if (allFail[i].includes('gvc99774')) {
      console.log(`  ${allFail[i]} (${new Date(parseInt(allFail[i+1])).toISOString()})`);
    }
  }

  // 9. Check if this FG had a previous invite completed for this email
  //    from an earlier time (pre-remove flow)
  console.log(`\n=== All completed jobs for FG ${fgId} ===`);
  for (let i = 0; i < allComp.length; i += 2) {
    if (allComp[i].includes(fgId)) {
      console.log(`  ${allComp[i]} (${new Date(parseInt(allComp[i+1])).toISOString()})`);
    }
  }

  console.log(`\n=== All failed jobs for FG ${fgId} ===`);
  for (let i = 0; i < allFail.length; i += 2) {
    if (allFail[i].includes(fgId)) {
      console.log(`  ${allFail[i]} (${new Date(parseInt(allFail[i+1])).toISOString()})`);
    }
  }

  // 10. Check for retry- prefixed jobs for this task
  const retryPattern = `${prefix}:${qn}:retry-${taskId}*`;
  const retryKeys = await redis.keys(retryPattern);
  console.log(`\nRetry keys for this task: ${retryKeys.length}`);

  await redis.quit();
}

main().catch(e => { console.error(e); process.exit(1); });
