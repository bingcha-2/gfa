import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'remote-data');
fs.mkdirSync(dataDir, { recursive: true });

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, data } = JSON.parse(body);
        fs.writeFileSync(path.join(dataDir, `${name}.json`), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        console.log(`✅ ${name}.json (${(body.length/1024).toFixed(1)}KB)`);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end('{"ok":true}');
        if (name === 'done') { console.log('\n🎉 全部完成!'); setTimeout(() => process.exit(0), 500); }
      } catch(e) { res.writeHead(400); res.end(e.message); }
    });
  }
});
server.listen(19876, '0.0.0.0', () => console.log('🚀 接收服务器已启动: http://127.0.0.1:19876'));
