const fs = require('fs');
const path = require('path');

let providers = {};

function loadProviders() {
  const file = path.join(__dirname, 'providers.json');
  try {
    providers = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log('[Providers] Loaded:', Object.keys(providers));
  } catch (err) {
    console.error('❌ Erreur chargement providers.json', err);
    providers = {};
  }
}
loadProviders();

function getProvider(name) {
  return providers[name] && providers[name].enabled ? providers[name] : null;
}
function getAllProviders() {
  return Object.keys(providers).filter(k => providers[k].enabled);
}
module.exports = { getProvider, getAllProviders, loadProviders };
