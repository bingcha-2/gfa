import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Try various setup API endpoints
    'echo "=== TRY 1 ==="',
    `curl -s -X POST http://localhost:8080/api/setup/test-db -H "Content-Type: application/json" -d '{}'`,
    'echo ""',
    'echo "=== TRY 2 ==="',
    `curl -s http://localhost:8080/api/setup`,
    'echo ""',
    'echo "=== TRY 3 ==="',
    `curl -s -X POST http://localhost:8080/setup/api/test-db -H "Content-Type: application/json" -d '{}'`,
    'echo ""',
    'echo "=== TRY 4 ==="',
    `curl -s -X POST http://localhost:8080/api/v1/setup -H "Content-Type: application/json" -d '{}'`,
    'echo ""',
    'echo "=== TRY 5 ==="',
    `curl -s http://localhost:8080/api/v1/system/setup`,
    'echo ""',
    'echo "=== TRY 6: test-database ==="',
    `curl -s -X POST http://localhost:8080/api/v1/setup/test-database -H "Content-Type: application/json" -d '{"host":"postgres","port":5432,"username":"sub2api","password":"013fdf4ec7073eb2bb71d187dd122efac4a43b8d4c07b6c886a34228e700dd1b","database":"sub2api","ssl_mode":"disable"}'`,
    'echo ""',
    'echo "=== TRY 7: complete ==="',
    `curl -s -X POST http://localhost:8080/api/v1/setup/complete -H "Content-Type: application/json" -d '{"database":{"host":"postgres","port":5432,"username":"sub2api","password":"013fdf4ec7073eb2bb71d187dd122efac4a43b8d4c07b6c886a34228e700dd1b","database":"sub2api","ssl_mode":"disable"},"redis":{"host":"redis","port":6379,"password":"","db":0},"admin":{"email":"bingcha135@gmail.com","password":"7b1bf501d047690c15a0488a84f25f767"}}'`,
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
