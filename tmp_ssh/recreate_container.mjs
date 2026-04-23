import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Remove .installed flag again
    'rm -f /root/sub2api-deploy/data/.installed',
    'echo "Removed .installed"',
    
    // Stop and remove the sub2api container completely, then recreate
    'echo "=== RECREATING CONTAINER ==="',
    'cd /root/sub2api-deploy && docker compose down sub2api 2>&1 && docker compose up -d sub2api 2>&1',
    'echo ""',
    
    // Wait for startup
    'sleep 20',
    
    // Check logs for admin creation
    'echo "=== STARTUP LOGS ==="',
    'docker logs sub2api 2>&1 | grep -i -E "admin|setup|install|user|password|created" | head -20',
    'echo ""',
    
    // Check users
    'echo "=== USERS ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "SELECT id, email, role FROM users;" 2>&1`,
    'echo ""',
    
    // Check .installed
    'echo "=== INSTALLED FLAG ==="',
    `cat /root/sub2api-deploy/data/.installed 2>&1`,
    'echo ""',
    
    // Try login
    'echo "=== LOGIN ==="',
    `curl -s -X POST http://localhost:8080/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"bingcha135@gmail.com","password":"7b1bf501d047690c15a0488a84f25f767"}'`,
    'echo ""',
    'echo "=== DONE ==="',
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
      output += data.toString();
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
