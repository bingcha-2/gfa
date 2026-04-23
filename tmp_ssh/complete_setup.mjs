import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Find the setup API endpoints
    'echo "=== SETUP ENDPOINTS ==="',
    `curl -s -X POST http://localhost:8080/api/v1/setup/db/test -H "Content-Type: application/json" -d '{"host":"postgres","port":5432,"user":"sub2api","password":"013fdf4ec7073eb2bb71d187dd122efac4a43b8d4c07b6c886a34228e700dd1b","dbname":"sub2api","sslmode":"disable"}'`,
    'echo ""',
    'echo "=== DB TEST DONE ==="',
    `curl -s -X POST http://localhost:8080/api/v1/setup/redis/test -H "Content-Type: application/json" -d '{"host":"redis","port":6379,"password":"","db":0}'`,
    'echo ""',
    'echo "=== REDIS TEST DONE ==="',
    // Try completing the setup
    `curl -s -X POST http://localhost:8080/api/v1/setup/install -H "Content-Type: application/json" -d '{"database":{"host":"postgres","port":5432,"user":"sub2api","password":"013fdf4ec7073eb2bb71d187dd122efac4a43b8d4c07b6c886a34228e700dd1b","dbname":"sub2api","sslmode":"disable"},"redis":{"host":"redis","port":6379,"password":"","db":0},"admin":{"email":"bingcha135@gmail.com","password":"7b1bf501d047690c15a0488a84f25f767"}}'`,
    'echo ""',
    'echo "=== INSTALL DONE ==="',
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
      // ignore stderr (curl progress)
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
