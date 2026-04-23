import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected!');
  const commands = [
    'echo "===ENV_START==="',
    'cat /root/sub2api-deploy/.env 2>/dev/null || echo "NO_DEPLOY_ENV"',
    'echo "===ENV_END==="',
    'echo "===DOCKER_START==="',
    'docker ps --format "{{.Names}} {{.Image}} {{.Status}}" 2>/dev/null || echo "NO_DOCKER"',
    'echo "===DOCKER_END==="',
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
      console.error('STDERR:', data.toString());
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
