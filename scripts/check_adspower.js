const fs = require('fs');
const path = require('path');
const http = require('http');

// Manually parse .env file to be dependency-free
try {
  const envPath = path.join(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const firstEq = trimmed.indexOf('=');
      if (firstEq === -1) return;
      const key = trimmed.substring(0, firstEq).trim();
      let val = trimmed.substring(firstEq + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.substring(1, val.length - 1);
      } else if (val.startsWith("'") && val.endsWith("'")) {
        val = val.substring(1, val.length - 1);
      }
      process.env[key] = val;
    });
  }
} catch (e) {
  console.warn('Warning: Could not load .env file:', e.message);
}

const host = process.env.ADSPOWER_HOST || 'http://127.0.0.1:50325';
const apiKey = process.env.ADSPOWER_API_KEY;
const poolIds = (process.env.ADSPOWER_POOL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

console.log('=== AdsPower Configuration Diagnostics ===');
console.log(`AdsPower Host: ${host}`);
console.log(`AdsPower API Key: ${apiKey ? apiKey.slice(0, 8) + '...' : 'NOT SET'}`);
console.log(`Configured Pool IDs (${poolIds.length}): ${poolIds.join(', ')}`);
console.log('\n--- Testing Connectivity ---');

function get(pathStr, params = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(pathStr, host);
    if (apiKey) {
      parsedUrl.searchParams.set('api_key', apiKey);
    }
    for (const [k, v] of Object.entries(params)) {
      parsedUrl.searchParams.set(k, v);
    }

    const options = {
      method: 'GET',
      headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
    };

    const req = http.request(parsedUrl.toString(), options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(data)
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            body: data
          });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });
    req.end();
  });
}

async function run() {
  // Test 1: Check status / health of AdsPower API
  try {
    const statusRes = await get('/status');
    console.log('API /status response:', JSON.stringify(statusRes.body));
  } catch (err) {
    console.error('❌ Failed to connect to AdsPower API. Is the AdsPower App running with Local API enabled?');
    console.error(`Error details: ${err.message}`);
    process.exit(1);
  }

  // Test 2: Check each configured profile ID
  console.log('\n--- Checking Configured Profile IDs ---');
  for (const pid of poolIds) {
    try {
      const activeRes = await get('/api/v1/browser/active', { user_id: pid });
      console.log(`Profile ${pid}: code=${activeRes.body?.code}, msg=${activeRes.body?.msg}, status=${activeRes.body?.data?.status || 'unknown'}`);
    } catch (err) {
      console.error(`❌ Error checking profile ${pid}: ${err.message}`);
    }
  }

  // Test 3: List actual profiles in AdsPower to see if they match
  console.log('\n--- Fetching Profile List from AdsPower ---');
  try {
    const listRes = await get('/api/v1/user/list', { page_size: '50' });
    if (listRes.body && listRes.body.code === 0) {
      const list = listRes.body.data?.list || [];
      console.log(`Found ${list.length} profiles in AdsPower:`);
      list.forEach(p => {
        const inPool = poolIds.includes(p.user_id) ? '✅ IN POOL' : '❌ NOT IN POOL';
        console.log(` - ID: ${p.user_id} | Name: ${p.name || 'Unnamed'} | Group: ${p.group_name || 'No Group'} | ${inPool}`);
      });
    } else {
      console.log(`Failed to retrieve profile list: code=${listRes.body?.code}, msg=${listRes.body?.msg}`);
    }
  } catch (err) {
    console.error(`❌ Error fetching profile list: ${err.message}`);
  }
}

run().catch(console.error);
