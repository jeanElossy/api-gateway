// src/server.js

require('dotenv').config();
const app = require('./app');
const config = require('./config'); // Récupère les configs centralisées

const PORT = config.port || 4000;

const server = app.listen(PORT, () => {
  console.log(`[Gateway] API listening on port ${PORT} (${config.nodeEnv})`);
});

// Gestion des erreurs serveur (port occupé, crash, etc.)
server.on('error', (err) => {
  console.error(`[Gateway] Erreur serveur: ${err.message}`);
  process.exit(1);
});

// Catch des exceptions non gérées (anti-crash)
process.on('uncaughtException', (err) => {
  console.error('[Gateway] Uncaught Exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Gateway] Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
