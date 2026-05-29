const http = require('http');

const passwords = ['admin', 'admin123', 'password', '123456', 'Admin123', 'gfa123'];

async function tryLogin(email, password) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ email, password });
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        resolve({ status: res.statusCode, body: body.substring(0, 200) });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.write(data);
    req.end();
  });
}

async function main() {
  const emails = ['admin@gfa.local', 'admin1@gfa.local', 'test1@gfa.local'];
  
  // First just test if the API responds at all
  console.log('Testing API auth endpoint...\n');
  
  for (const email of emails) {
    for (const pw of passwords) {
      const result = await tryLogin(email, pw);
      const marker = result.status === 200 ? '✅ SUCCESS' : `❌ ${result.status}`;
      console.log(`${marker} | ${email} / ${pw} => ${result.body}`);
      if (result.status === 200) {
        console.log('\n🎉 Found working credentials!');
        return;
      }
    }
    console.log('');
  }
  console.log('No working credentials found with common passwords.');
}

main();
