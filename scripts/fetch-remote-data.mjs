#!/usr/bin/env node
/**
 * 启动一个临时本地 HTTP 服务器来接收浏览器发送的数据
 * 1. 启动本地服务器
 * 2. 在浏览器控制台执行打印出的 JS 代码
 * 3. 浏览器 fetch API 数据后 POST 回本地服务器
 * 4. 本地服务器将数据写入文件
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'scripts', 'remote-data');

// Ensure data dir exists
fs.mkdirSync(dataDir, { recursive: true });

const received = {};
let expectedCount = 4; // accounts, family-groups, members (all), plus a signal

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, data } = JSON.parse(body);
        const filePath = path.join(dataDir, `${name}.json`);
        fs.writeFileSync(filePath, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        console.log(`✅ Saved ${name}.json (${(body.length / 1024).toFixed(1)} KB)`);
        received[name] = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        if (name === 'done') {
          console.log('\n🎉 All data received! Stopping server...');
          setTimeout(() => process.exit(0), 500);
        }
      } catch (e) {
        console.error('Error:', e.message);
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const PORT = 19876;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 Local receiver listening on http://127.0.0.1:${PORT}`);
  console.log(`\n📋 请在 https://bcai.site/console 的浏览器控制台中执行以下代码:\n`);
  console.log(`${'='.repeat(70)}`);
  console.log(`
(async () => {
  const LOCAL = 'http://127.0.0.1:${PORT}';
  const send = async (name, data) => {
    await fetch(LOCAL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, data })
    });
    console.log('✅ Sent:', name);
  };

  try {
    console.log('Fetching accounts...');
    const acc = await fetch('/api/proxy/accounts', { headers: { accept: 'application/json' } }).then(r => r.text());
    await send('accounts', acc);

    console.log('Fetching family-groups...');
    const fg = await fetch('/api/proxy/family-groups', { headers: { accept: 'application/json' } }).then(r => r.text());
    await send('family-groups', fg);
    
    // Parse family groups to get all member data
    const groups = JSON.parse(fg);
    const allMembers = [];
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (g.members) allMembers.push(...g.members);
      }
    }
    await send('family-members', JSON.stringify(allMembers));

    await send('done', JSON.stringify({ message: 'all done', timestamp: new Date().toISOString() }));
    console.log('🎉 All data sent!');
  } catch(e) {
    console.error('Error:', e);
  }
})();
  `);
  console.log(`${'='.repeat(70)}`);
  console.log(`\n⏳ Waiting for data...`);
});

// Auto-close after 5 minutes
setTimeout(() => {
  console.log('\n⏰ Timeout (5min). Stopping server.');
  process.exit(1);
}, 5 * 60 * 1000);
