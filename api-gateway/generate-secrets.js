// generate-secrets.js
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function randomSecret(length = 48) {
  // Génère un secret base64 safe
  return crypto.randomBytes(length).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, length);
}

const secrets = {
  JWT_SECRET: randomSecret(64),
  INTERNAL_TOKEN: randomSecret(64)
};

console.log('--- Nouveaux secrets ultra-sécurisés ---');
console.log(`JWT_SECRET=${secrets.JWT_SECRET}`);
console.log(`INTERNAL_TOKEN=${secrets.INTERNAL_TOKEN}`);

const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) {
  // Patch l’existant sans écraser le reste
  let env = fs.readFileSync(ENV_PATH, 'utf8');
  env = env.replace(/^JWT_SECRET=.*/m, `JWT_SECRET=${secrets.JWT_SECRET}`);
  env = env.replace(/^INTERNAL_TOKEN=.*/m, `INTERNAL_TOKEN=${secrets.INTERNAL_TOKEN}`);
  fs.writeFileSync(ENV_PATH, env, 'utf8');
  console.log(`\n⚡️ Les valeurs ont été mises à jour dans .env`);
} else {
  // Génère un .env tout neuf
  fs.writeFileSync(
    ENV_PATH,
    `JWT_SECRET=${secrets.JWT_SECRET}\nINTERNAL_TOKEN=${secrets.INTERNAL_TOKEN}\n`,
    'utf8'
  );
  console.log('\n⚡️ Un nouveau fichier .env a été créé !');
}

console.log('\n--- Copie/colle dans Render ou ta prod si besoin ---');
