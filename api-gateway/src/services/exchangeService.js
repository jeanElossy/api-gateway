const ExchangeRate = require("../models/ExchangeRate");

/**
 * Récupère le taux de change dynamique (DB, sinon 1 par défaut)
 * @param {string} from - Devise de départ (ex: EUR)
 * @param {string} to   - Devise d’arrivée (ex: XOF)
 * @returns {Promise<number>} - Taux (ex: 655.957)
 */
exports.getExchangeRate = async (from, to) => {
  if (!from || !to || from.toUpperCase() === to.toUpperCase()) return 1;
  const found = await ExchangeRate.findOne({ from: from.toUpperCase(), to: to.toUpperCase(), active: true });
  if (found && found.rate) return found.rate;
  // Tu peux ajouter ici un fallback (appeler un provider externe si rien en DB)
  return 1; // fallback "sécurité"
};
