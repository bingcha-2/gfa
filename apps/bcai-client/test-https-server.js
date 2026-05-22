// HTTPS 测试服务器 v4 - CA 根证书 + 服务器证书
const https = require('https');
const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const PORT = 60680;
const DOMAIN = 'cloudcode-pa.googleapis.com';
const CERT_DIR = path.join(__dirname, 'test-certs');
const CA_CERT_PATH = path.join(CERT_DIR, 'bcai-ca.crt');
const CA_KEY_PATH = path.join(CERT_DIR, 'bcai-ca.key');

if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

// ─── 第1步：生成 CA 根证书 ───
console.log('生成 CA 根证书...');
const caKeys = forge.pki.rsa.generateKeyPair(2048);
const caCert = forge.pki.createCertificate();
caCert.publicKey = caKeys.publicKey;
caCert.serialNumber = '01';
caCert.validity.notBefore = new Date();
caCert.validity.notAfter = new Date();
caCert.validity.notAfter.setFullYear(caCert.validity.notAfter.getFullYear() + 5);

const caAttrs = [
  { name: 'commonName', value: 'BCAI Local CA' },
  { name: 'organizationName', value: 'BCAI' },
];
caCert.setSubject(caAttrs);
caCert.setIssuer(caAttrs);
caCert.setExtensions([
  { name: 'basicConstraints', cA: true },
  { name: 'keyUsage', keyCertSign: true, cRLSign: true },
]);
caCert.sign(caKeys.privateKey, forge.md.sha256.create());

// 保存 CA 证书文件
fs.writeFileSync(CA_CERT_PATH, forge.pki.certificateToPem(caCert));
fs.writeFileSync(CA_KEY_PATH, forge.pki.privateKeyToPem(caKeys.privateKey));
console.log(`CA 根证书已保存到: ${CA_CERT_PATH}`);

// ─── 第2步：用 CA 签发服务器证书 ───
console.log(`为 ${DOMAIN} 签发服务器证书...`);
const serverKeys = forge.pki.rsa.generateKeyPair(2048);
const serverCert = forge.pki.createCertificate();
serverCert.publicKey = serverKeys.publicKey;
serverCert.serialNumber = '02';
serverCert.validity.notBefore = new Date();
serverCert.validity.notAfter = new Date();
serverCert.validity.notAfter.setFullYear(serverCert.validity.notAfter.getFullYear() + 1);

serverCert.setSubject([{ name: 'commonName', value: DOMAIN }]);
serverCert.setIssuer(caAttrs); // 由 CA 签发
serverCert.setExtensions([
  { name: 'basicConstraints', cA: false },
  { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
  { name: 'extKeyUsage', serverAuth: true },
  { name: 'subjectAltName', altNames: [
    { type: 2, value: DOMAIN },
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ]},
]);
serverCert.sign(caKeys.privateKey, forge.md.sha256.create()); // CA 私钥签名

const pemKey = forge.pki.privateKeyToPem(serverKeys.privateKey);
const pemCert = forge.pki.certificateToPem(serverCert);
console.log('服务器证书生成完毕\n');

// ─── 第3步：启动服务器 ───
let connCount = 0;
let reqCount = 0;

const server = https.createServer({ key: pemKey, cert: pemCert }, (req, res) => {
  reqCount++;
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`\n${'★'.repeat(30)}`);
  console.log(`[${ts}] HTTP 请求 #${reqCount} 到达！`);
  console.log(`  ${req.method} ${req.url}`);
  console.log(`  Host: ${req.headers.host}`);
  console.log(`  Content-Type: ${req.headers['content-type'] || '(none)'}`);
  console.log(`${'★'.repeat(30)}`);

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    if (chunks.length) {
      console.log(`  Body(前500字符): ${Buffer.concat(chunks).toString('utf8').substring(0, 500)}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

server.on('secureConnection', () => {
  connCount++;
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] ✅ TLS 连接 #${connCount} 成功`);
});

server.on('tlsClientError', (err) => {
  connCount++;
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] ❌ TLS 错误 #${connCount}: ${err.message.substring(0, 120)}`);
});

server.on('connection', () => {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] 🔌 TCP 连接到达`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🔒 HTTPS 测试服务器 v4: https://127.0.0.1:${PORT}`);
  console.log(`\n${'='.repeat(50)}`);
  console.log(`安装 CA 证书到系统信任存储（管理员 PowerShell）：`);
  console.log(`certutil -addstore Root "${CA_CERT_PATH}"`);
  console.log(`${'='.repeat(50)}`);
  console.log(`\n然后关闭 IDE 重新打开，发对话测试。`);
  console.log(`\n测试完后删除 CA 证书：`);
  console.log(`certutil -delstore Root "BCAI Local CA"\n`);
});
