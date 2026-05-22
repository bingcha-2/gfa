const fs = require('fs');
const filePath = 'C:/Users/Administrator/Desktop/GFA/apps/bcai-client/src/main/https-gateway.ts';
let c = fs.readFileSync(filePath, 'utf8');

const old = `res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
          proxyRes.pipe(res)`;

const replacement = `// 捕获非200响应体用于调试
          if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
            const errChunks: Buffer[] = []
            proxyRes.on('data', (ch: Buffer) => errChunks.push(ch))
            proxyRes.on('end', () => {
              const errBody = Buffer.concat(errChunks)
              const snippet = errBody.toString('utf8').substring(0, 500)
              this.logFn(\`[Gateway] error response (\${proxyRes.statusCode}): \${snippet}\`)
              this.writeAccessLog({ reqId, phase: 'error-body', statusCode: proxyRes.statusCode, body: snippet })
              res.writeHead(proxyRes.statusCode, proxyRes.headers)
              res.end(errBody)
            })
          } else {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
            proxyRes.pipe(res)
          }`;

if (c.includes(old)) {
  c = c.replace(old, replacement);
  fs.writeFileSync(filePath, c);
  console.log('patched OK');
} else {
  console.log('target not found');
}
