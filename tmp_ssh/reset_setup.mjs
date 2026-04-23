import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Delete the .installed flag
    'echo "=== REMOVING .installed ==="',
    'rm -f /root/sub2api-deploy/data/.installed',
    'echo "removed"',
    
    // Restart the container
    'echo "=== RESTARTING ==="',
    'cd /root/sub2api-deploy && docker compose restart sub2api 2>&1',
    'echo ""',
    
    // Wait for startup
    'sleep 15',
    
    // Check if admin was created
    'echo "=== CHECK USERS ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "SELECT id, email, role FROM users;" 2>&1`,
    'echo ""',
    
    // Check setup status
    'echo "=== SETUP STATUS ==="',
    `curl -s http://localhost:8080/setup/status`,
    'echo ""',
    
    // Check recent logs for admin creation
    'echo "=== LOGS ==="',
    'docker logs sub2api --tail 30 2>&1 | grep -i -E "admin|user|setup|install"',
    'echo ""',
    
    // Try login
    'echo "=== LOGIN TEST ==="',
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
