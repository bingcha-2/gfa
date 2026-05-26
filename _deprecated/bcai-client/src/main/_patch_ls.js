const fs = require('fs');
const f = 'C:/Users/Administrator/Desktop/GFA/apps/bcai-client/src/main/index.ts';
let c = fs.readFileSync(f, 'utf8');

const old = "sendNotification('HTTPS 网关已启用')\n            log('[Gateway] 网关模式已完全启用')";

const repl = `// 6.5 杀掉 language_server 让它重新解析 DNS（命中 hosts 拦截）
            try {
              execFileSync('taskkill', ['/IM', 'language_server_windows_x64.exe', '/F'], { stdio: 'ignore' })
              log('[Gateway] language_server 已重启（刷新 DNS）')
            } catch { log('[Gateway] language_server 未找到（可能已停止）') }

            sendNotification('HTTPS 网关已启用')
            log('[Gateway] 网关模式已完全启用')`;

if (c.includes(old)) {
  c = c.replace(old, repl);
  fs.writeFileSync(f, c);
  console.log('patched OK');
} else {
  console.log('NOT FOUND');
}
