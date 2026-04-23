import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  // Try login via API from inside docker network
  const commands = [
    // First try to login
    `curl -s -X POST http://localhost:8080/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"bingcha135@gmail.com","password":"7b1bf501d047690c15a0488a84f25f767"}'`,
    'echo ""',
    'echo "===SEP==="',
    // Also try the setup status
    `curl -s http://localhost:8080/api/v1/settings/public`,
    'echo ""',
    'echo "===SEP2==="',
    // Check setup API
    `curl -s http://localhost:8080/api/v1/setup/status`,
    'echo ""',
    'echo "===SEP3==="',
    // Try default admin email
    `curl -s -X POST http://localhost:8080/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"admin@sub2api.local","password":"7b1bf501d047690c15a0488a84f25f767"}'`,
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
      // ignore stderr
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
