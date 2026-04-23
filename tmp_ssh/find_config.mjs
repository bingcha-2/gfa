import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  
  const commands = [
    // Check the config.yaml content
    'echo "=== CONFIG YAML ==="',
    `docker exec sub2api cat /app/data/config.yaml 2>&1`,
    'echo ""',
    // List all files in data dir
    'echo "=== DATA FILES ==="', 
    `docker exec sub2api find /app/data -maxdepth 2 -type f ! -path "*/logs/*" 2>&1`,
    'echo ""',
    // Check the host data directory  
    'echo "=== HOST DATA ==="',
    `ls -la /root/sub2api-deploy/data/ 2>&1`,
    'echo ""',
    `cat /root/sub2api-deploy/data/config.yaml 2>&1`,
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
