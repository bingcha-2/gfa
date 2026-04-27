const { PrismaClient } = require(require('path').resolve(__dirname, 'node_modules/@prisma/client'));
const p = new PrismaClient();
p.consoleUser.findMany({ select: { username: true, role: true } })
  .then(function(u) { console.log(JSON.stringify(u, null, 2)); return p['$disconnect'](); })
  .catch(function(e) { console.error(e); process.exit(1); });
