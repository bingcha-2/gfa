module.exports = {
  apps: [
    {
      name: 'gfa-daemon',
      script: 'C:\\Users\\Administrator\\Desktop\\GFA\\scripts\\start.mjs',
      args: '--no-build',
      cwd: 'C:\\Users\\Administrator\\Desktop\\GFA',
      interpreter: 'node',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '10s',
      kill_timeout: 5000,
    },
    {
      name: 'caddy',
      script: 'C:\\Users\\Administrator\\Desktop\\caddy\\caddy.exe',
      args: 'run --config Caddyfile',
      cwd: 'C:\\Users\\Administrator\\Desktop\\caddy',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '5s',
      kill_timeout: 3000,
    },
  ],
};
