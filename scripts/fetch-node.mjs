import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'remote-data');
fs.mkdirSync(dataDir, { recursive: true });

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbW44c3loam0wMDAweGs3b3RxNHVoNnhxIiwiZW1haWwiOiJhZG1pbkBnZmEubG9jYWwiLCJyb2xlIjoiQURNSU4iLCJpYXQiOjE3NzU3Mjc2NjgsImV4cCI6MTc3NTc3MDg2OH0.ZEUXPly2uhrdDXnjAdjopdBS7bbyKCUWlM89x3a5MA8';

function fetchAPI(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'bcai.site',
      path: '/api/proxy/' + urlPath,
      headers: {
        'Accept': 'application/json',
        'Cookie': 'gfa.console.token=' + TOKEN,
        'User-Agent': 'Mozilla/5.0',
      },
      rejectUnauthorized: false,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0,200)}`));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function main() {
  const endpoints = ['accounts', 'family-groups'];
  for (const ep of endpoints) {
    process.stdout.write(`⏳ ${ep}...`);
    try {
      const data = await fetchAPI(ep);
      fs.writeFileSync(path.join(dataDir, ep + '.json'), data);
      console.log(` ✅ ${(data.length/1024).toFixed(1)}KB`);
    } catch(e) {
      console.log(` ❌ ${e.message}`);
    }
  }
  console.log('\n📂 文件:', fs.readdirSync(dataDir).join(', '));
}

main();
