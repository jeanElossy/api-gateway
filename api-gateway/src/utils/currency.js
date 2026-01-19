// File: api-gateway/src/utils/currency.js
'use strict';

/**
 * Normalise une devise en code ISO (EUR, USD, CAD, XOF, XAF, GBP…)
 * - Accepte symboles (€,$,£)
 * - Gère "F CFA" / "FCFA" / "CFA" → XOF ou XAF (selon pays)
 * - Gère "$CAD", "CAD$", "USD$" → CAD / USD...
 *
 * @param {string} input
 * @param {string} countryHint  (optionnel) ex: "Côte d'Ivoire", "cameroun"
 * @returns {string} code ISO upper-case ou chaîne vide
 */
function normalizeCurrency(input, countryHint = '') {
  if (!input) return '';

  const raw = String(input).trim().toUpperCase(); // ex: "$CAD", "F CFA"
  const compact = raw.replace(/\s+/g, '');        // ex: "FCFA"
  const lettersOnly = raw.replace(/[^A-Z]/g, ''); // ex: "CAD" pour "$CAD"

  const KNOWN_ISO = ['EUR', 'USD', 'CAD', 'XOF', 'XAF', 'GBP'];

  // ---- helper pays -> zone CFA
  const normCountry = String(countryHint || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  const isCentralAfrica =
    normCountry.includes('cameroun') ||
    normCountry.includes('cameroon') ||
    normCountry.includes('gabon') ||
    normCountry.includes('tchad') ||
    normCountry.includes('chad') ||
    normCountry.includes('congo') ||
    normCountry.includes('guinee equatoriale') ||
    normCountry.includes('equatorial guinea') ||
    normCountry.includes('centrafrique') ||
    normCountry.includes('central african') ||
    normCountry.includes('rdc') ||
    normCountry.includes('republique centrafricaine');

  // 1) CFA (avant tout)
  const cfaKeywords = ['F CFA', 'FCFA', 'F.CFA', 'FRANC CFA', 'FRANCS CFA', 'CFA'];
  if (cfaKeywords.includes(raw) || cfaKeywords.includes(compact)) {
    return isCentralAfrica ? 'XAF' : 'XOF';
  }

  // 2) Déjà ISO propre
  if (KNOWN_ISO.includes(raw)) return raw;

  // 3) Récupération lettres ($CAD, CAD$, USD$)
  if (lettersOnly.length === 3 && KNOWN_ISO.includes(lettersOnly)) return lettersOnly;

  // 4) Symboles simples
  if (raw === '€') return 'EUR';
  if (raw === '£') return 'GBP';
  if (raw === '$') return 'USD'; // par défaut

  // 5) Fallback
  if (/^[A-Z]{3}$/.test(raw)) return raw;
  return lettersOnly || compact;
}

module.exports = {
  normalizeCurrency,
};
