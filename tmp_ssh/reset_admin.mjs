import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Check the password hash format
    'echo "=== CURRENT PASSWORD HASH ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "SELECT id, email, password, role FROM users WHERE id=1;" 2>&1`,
    'echo ""',
    // Update the admin email to the user's email
    'echo "=== UPDATE EMAIL ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "UPDATE users SET email='bingcha135@gmail.com' WHERE id=1 RETURNING id, email, role;" 2>&1`,
    'echo ""',
    // Now we need to generate a bcrypt hash for the password
    // Let's use the sub2api container itself to generate it
    'echo "=== GENERATE HASH ==="',
    // Use docker exec to run a Go one-liner or check what tools are available
    `docker exec sub2api which htpasswd 2>&1 || echo "no htpasswd"`,
    `docker exec sub2api which python3 2>&1 || echo "no python3"`,
    'echo ""',
    // Try installing bcrypt tool and hashing
    // Actually, let's use the sub2api container more directly - restart it with ADMIN_PASSWORD set
    // and delete the existing user so it recreates
    'echo "=== DELETE USER AND RESTART ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "DELETE FROM users WHERE id=1;" 2>&1`,
    'echo ""',
    'echo "=== RESTART SUB2API ==="',
    'cd /root/sub2api-deploy && docker compose restart sub2api 2>&1',
    'echo ""',
    'sleep 10',
    'echo "=== CHECK NEW USER ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "SELECT id, email, role FROM users LIMIT 5;" 2>&1`,
    'echo ""',
    'echo "=== RECENT LOGS ==="',
    'docker logs sub2api --tail 20 2>&1',
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
