const Redis = require('ioredis');

async function main() {
  const redis = new Redis('redis://localhost:6379');

  const fgId = 'cmnikt6fv00g6xkh4u71dps4y';
  const email = 'gvc99774@gmail.com';
  const dedupJobId = `invite:${fgId}:${email}`;
  const prefix = 'bull';
  const qn = 'family-invite-queue';

  console.log('=== Checking BullMQ dedup for:', dedupJobId, '===');

  // Check if the job hash exists in Redis
  const jobHash = await redis.hgetall(`${prefix}:${qn}:${dedupJobId}`);
  console.log('Job hash exists:', Object.keys(jobHash).length > 0);
  if (Object.keys(jobHash).length > 0) {
    for (const [k, v] of Object.entries(jobHash)) {
      console.log(`  ${k}: ${String(v).slice(0, 300)}`);
    }
  }

  // Check completed set
  const compKey = `${prefix}:${qn}:completed`;
  const inComp = await redis.zscore(compKey, dedupJobId);
  console.log('\nIn completed set:', inComp !== null
    ? `YES (ts=${new Date(parseInt(inComp)).toISOString()})`
    : 'NO');

  // Check failed set
  const failKey = `${prefix}:${qn}:failed`;
  const inFail = await redis.zscore(failKey, dedupJobId);
  console.log('In failed set:', inFail !== null
    ? `YES (ts=${new Date(parseInt(inFail)).toISOString()})`
    : 'NO');

  // Count completed
  const compCount = await redis.zcard(compKey);
  console.log('\nTotal completed:', compCount);

  // Find all invite: dedup keys in completed set
  const allComp = await redis.zrange(compKey, 0, -1);
  const invDedup = allComp.filter(id => id.startsWith('invite:'));
  console.log(`Completed jobs with 'invite:' dedup prefix: ${invDedup.length}`);
  for (const j of invDedup) {
    const sc = await redis.zscore(compKey, j);
    console.log(`  ${j} (${sc ? new Date(parseInt(sc)).toISOString() : '?'})`);
  }

  // Queue status
  const waitLen = await redis.llen(`${prefix}:${qn}:wait`);
  const activeLen = await redis.llen(`${prefix}:${qn}:active`);
  const delayedLen = await redis.zcard(`${prefix}:${qn}:delayed`);
  const failLen = await redis.zcard(failKey);

  console.log(`\n=== Queue Status ===`);
  console.log(`Waiting: ${waitLen}`);
  console.log(`Active: ${activeLen}`);
  console.log(`Delayed: ${delayedLen}`);
  console.log(`Completed: ${compCount}`);
  console.log(`Failed: ${failLen}`);

  // Check if there are any matching entries in failed set for this email
  const allFailed = await redis.zrange(failKey, 0, -1);
  const matchFailed = allFailed.filter(id => id.includes(email) || id.includes(fgId));
  if (matchFailed.length > 0) {
    console.log(`\nMatching failed jobs for email/FG:`);
    for (const j of matchFailed) {
      const sc = await redis.zscore(failKey, j);
      console.log(`  ${j} (${sc ? new Date(parseInt(sc)).toISOString() : '?'})`);
    }
  }

  await redis.quit();
}

main().catch(e => { console.error(e); process.exit(1); });
