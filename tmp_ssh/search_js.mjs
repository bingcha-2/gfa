import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Search the main JS bundle for setup-related API endpoints
    `curl -s http://localhost:8080/assets/index-CFipHNkm.js | grep -oP '"[^"]*setup[^"]*"' | head -30`,
    'echo ""',
    'echo "===SEP==="',
    `curl -s http://localhost:8080/assets/index-CFipHNkm.js | grep -oP '"[^"]*install[^"]*"' | head -20`,
    'echo ""',
    'echo "===SEP2==="',
    `curl -s http://localhost:8080/assets/index-CFipHNkm.js | grep -oP '"[^"]*test[_-]?d[^"]*"' | head -20`,
    'echo ""',
    'echo "===SEP3==="',
    // Search for admin registration endpoint
    `curl -s http://localhost:8080/assets/index-CFipHNkm.js | grep -oP '"[^"]*admin[^"]*"' | head -20`,
    'echo ""',
  ].join('; ');
  
  conn.exec(commands, (err, stream) => {
    if (err) { console.error('Exec error:', err); conn.end(); return; }
    let output = '';
    stream.on('close', () => {
      console.log(output);
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    }).stderr.on('data', (data) => {
      // ignore
    });
  });
}).on('error', (err) => {
  console.error('Connection error:', err.message);
}).connect({
  host: '154.12.88.124',
  port: 1958,
  username: 'root',
  password: 'nuruWSJQ9487',
  readyTimeout: 15000,
});
