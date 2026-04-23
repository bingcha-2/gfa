import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Check existing users in the database
    'echo "=== USERS IN DB ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "SELECT id, email, role, created_at FROM users LIMIT 10;" 2>&1`,
    'echo ""',
    'echo "=== TABLE LIST ==="',
    `docker exec sub2api-postgres psql -U sub2api -d sub2api -c "\\dt" 2>&1`,
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
