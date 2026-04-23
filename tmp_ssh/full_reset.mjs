import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    'cd /root/sub2api-deploy',
    
    // Delete config and installed flag
    'echo "=== REMOVING CONFIG ==="',
    'rm -f data/.installed data/config.yaml',
    'ls -la data/',
    'echo ""',
    
    // Down the whole stack and recreate
    'echo "=== DOWNING ALL ==="',
    'docker compose down 2>&1',
    'echo ""',
    
    // Also clear postgres data to start completely fresh
    // Actually, let's NOT clear postgres data - just config
    // The issue is that AUTO_SETUP checks if config.yaml exists
    
    'echo "=== BRINGING UP ==="',
    'docker compose up -d 2>&1',
    'echo ""',
    
    // Wait for startup and health check
    'sleep 25',
    
    // Check if admin was auto-created
    'echo "=== CHECK USERS ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "SELECT id, email, role FROM users;" 2>&1`,
    'echo ""',
    
    // Check logs for admin creation
    'echo "=== LOGS ==="',
    'docker logs sub2api 2>&1 | grep -i -E "admin|setup|install|created|auto" | head -20',
    'echo ""',
    
    // Check .installed
    'echo "=== INSTALLED ==="',
    'cat data/.installed 2>&1 || echo "NOT FOUND"',
    'echo ""',
    
    // Try login
    'echo "=== LOGIN ==="',
    `curl -s -X POST http://localhost:8080/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"bingcha135@gmail.com","password":"7b1bf501d047690c15a0488a84f25f767"}'`,
    'echo ""',
    'echo "=== DONE ==="',
  ].join(' && ');
  
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
