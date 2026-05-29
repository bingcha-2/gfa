const Redis = require('ioredis');

async function main() {
  const redis = new Redis('redis://localhost:6379');
  
  console.log('=== Active Jobs in automation-queue ===');
  const activeIds = await redis.lrange('bull:automation-queue:active', 0, -1);
  console.log(`Active Job IDs (Count: ${activeIds.length}):`, activeIds);
  
  for (const id of activeIds) {
    console.log(`\n--- Job ID: ${id} ---`);
    const jobKey = `bull:automation-queue:${id}`;
    const data = await redis.hgetall(jobKey);
    
    // Parse fields
    if (Object.keys(data).length === 0) {
      console.log(`No data found for key ${jobKey}`);
      continue;
    }
    
    console.log(`Name: ${data.name}`);
    try {
      const parsedData = JSON.parse(data.data);
      // Mask password for safety
      if (parsedData.credentials && parsedData.credentials.password) {
        parsedData.credentials.password = '***';
      }
      console.log('Data:', JSON.stringify(parsedData, null, 2));
    } catch (e) {
      console.log('Raw Data:', data.data);
    }
    
    console.log(`Opts: ${data.opts}`);
    console.log(`Failed Reason: ${data.failedReason}`);
    console.log(`Stacktrace: ${data.stacktrace}`);
    console.log(`Processed On: ${data.processedOn ? new Date(Number(data.processedOn)).toISOString() : 'N/A'}`);
    console.log(`Timestamp: ${data.timestamp ? new Date(Number(data.timestamp)).toISOString() : 'N/A'}`);
    
    // Also check lock
    const lockKey = `bull:automation-queue:${id}:lock`;
    const lockVal = await redis.get(lockKey);
    const lockTtl = await redis.ttl(lockKey);
    console.log(`Lock: ${lockVal || 'NONE'} | TTL: ${lockTtl}s`);
  }
  
  await redis.disconnect();
}

main().catch(console.error);
