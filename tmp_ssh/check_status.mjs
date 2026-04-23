import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Check setup status again
    'echo "=== SETUP STATUS ==="',
    `curl -s http://localhost:8080/setup/status`,
    'echo ""',
    // Check if there are any users
    'echo "=== USERS ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "SELECT * FROM users;" 2>&1`,
    'echo ""',
    // Check settings table for setup completion flag
    'echo "=== SETTINGS ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "SELECT key, value FROM settings WHERE key LIKE '%setup%' OR key LIKE '%install%';" 2>&1`,
    'echo ""',
    // Check all settings
    'echo "=== ALL SETTINGS ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "SELECT key FROM settings ORDER BY key;" 2>&1`,
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
