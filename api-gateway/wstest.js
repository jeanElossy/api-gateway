const https = require('https');
const crypto = require('crypto');

const host = 'api-gateway-8cgy.onrender.com';
const key = crypto.randomBytes(16).toString('base64');

const req = https.request({
  host, port: 443,
  path: '/socket.io/?EIO=4&transport=websocket',
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
    Origin: 'https://paynoval.com',
  },
});

const t0 = Date.now();
let done = false;

req.on('upgrade', (res) => {
  done = true;
  console.log(`✅ UPGRADE ACCEPTE en ${Date.now()-t0} ms — HTTP ${res.statusCode}`);
  console.log('   WebSocket fonctionne a travers le gateway.');
  process.exit(0);
});

req.on('response', (res) => {
  done = true;
  console.log(`❌ PAS D'UPGRADE — HTTP ${res.statusCode} en ${Date.now()-t0} ms`);
  let b=''; res.on('data',d=>b+=d); res.on('end',()=>{ console.log('   corps:', b.slice(0,200)); process.exit(0); });
});

req.on('error', (e) => { done = true; console.log('❌ ERREUR:', e.message); process.exit(0); });
setTimeout(()=>{ if(!done){ console.log('❌ TIMEOUT 30s'); process.exit(0);} }, 30000);
req.end();
