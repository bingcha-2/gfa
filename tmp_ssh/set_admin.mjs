import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Update .env to set admin email and password
    'cd /root/sub2api-deploy',
    // Use sed to update ADMIN_EMAIL and ADMIN_PASSWORD
    "sed -i 's/^ADMIN_EMAIL=.*/ADMIN_EMAIL=bingcha135@gmail.com/' .env",
    "sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=7b1bf501d047690c15a0488a84f25f767/' .env",
    // Verify the changes
    'echo "=== VERIFYING .env CHANGES ==="',
    'grep -E "ADMIN_EMAIL|ADMIN_PASSWORD" .env',
    // Restart sub2api container
    'echo "=== RESTARTING SUB2API ==="',
    'docker compose restart sub2api',
    'echo "=== WAITING FOR RESTART ==="',
    'sleep 10',
    // Check new logs
    'echo "=== NEW LOGS ==="',
    'docker logs sub2api --tail 30 2>&1',
    'echo "=== DONE ==="',
  ].join(' && ');
  
  conn.exec(commands, (err, stream) => {
    if (err) { console.error('Exec error:', err); conn.end(); return; }
    let output = '';
    stream.on('close', (code) => {
      console.log(output);
      console.log('Exit code:', code);
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    }).stderr.on('data', (data) => {
      output += 'STDERR: ' + data.toString();
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
