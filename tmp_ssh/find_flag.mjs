import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Look for config files inside the container
    'echo "=== DATA DIR ==="',
    `docker exec sub2api ls -la /app/data/ 2>&1`,
    'echo ""',
    'echo "=== CONFIG YAML ==="',
    `docker exec sub2api cat /app/data/config.yaml 2>&1`,
    'echo ""',
    'echo "=== SETUP COMPLETED FLAG ==="',
    `docker exec sub2api find /app -name "*.json" -o -name "*.yaml" -o -name "*.yml" -o -name "*.lock" -o -name ".setup*" -o -name ".installed*" 2>/dev/null | head -20`,
    'echo ""',
    'echo "=== CHECK SETUP FLAG IN CONFIG ==="',
    `docker exec sub2api grep -r "setup" /app/data/ 2>&1 | head -20`,
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
