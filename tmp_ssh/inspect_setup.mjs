import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Look at the setup page JS to find API endpoints
    `curl -s http://localhost:8080/setup | grep -o 'api[^"]*setup[^"]*' | head -20`,
    'echo ""',
    'echo "=== ASSETS ==="',
    // Find setup related JS files
    `curl -s http://localhost:8080/setup | grep -oP 'src="[^"]*"' | head -20`,
    'echo ""',
    'echo "=== SETUP JS ==="',
    // Find setup JS file
    `curl -s http://localhost:8080/setup | grep -oP 'Setup[^"]*\\.js' | head -10`,
    'echo ""',
    'echo "=== ALL JS ==="',
    `curl -s http://localhost:8080/setup | grep -oP '/assets/[^"]*\\.js' | head -20`,
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
