import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Wait more and check
    'sleep 10',
    
    // Check .installed
    'echo "=== INSTALLED ==="',
    'cat /root/sub2api-deploy/data/.installed 2>&1 || echo "NOT FOUND"',
    'echo ""',
    
    // Check setup status
    'echo "=== STATUS ==="',
    `curl -s http://localhost:8080/setup/status 2>&1`,
    'echo ""',
    
    // Check users
    'echo "=== USERS ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "SELECT id, email, role FROM users;" 2>&1`,
    'echo ""',
    
    // Full startup logs  
    'echo "=== ALL LOGS ==="',
    'docker logs sub2api 2>&1 | head -60',
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
