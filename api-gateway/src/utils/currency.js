'use strict';

/**
 * Normalise une devise en code ISO (EUR, USD, CAD, XOF, XAF, GBP…)
 * - Accepte symboles (€,$,£)
 * - Gère "F CFA" / "FCFA" / "CFA" → XOF ou XAF (selon pays)
 * - Gère "$CAD", "CAD$", "USD$" → CAD / USD...
 *
 * IMPORTANT:
 * - Retourne soit un ISO propre (3 lettres), soit "".
 * - N'envoie jamais du bruit ("FCFA", "CADUSD", etc.)
 *
 * @param {string} input
 * @param {string} countryHint  (optionnel) ex: "Côte d'Ivoire", "cameroun"
 * @returns {string} code ISO upper-case ou chaîne vide
 */
function normalizeCurrency(input, countryHint = '') {
  if (input == null) return '';

  const raw = String(input).replace(/\u00A0/g, ' ').trim().toUpperCase();
  if (!raw) return '';

  const compact = raw.replace(/\s+/g, '');        // ex: "FCFA"
  const lettersOnly = raw.replace(/[^A-Z]/g, ''); // ex: "CAD" pour "$CAD"

  const KNOWN_ISO = new Set(['EUR', 'USD', 'CAD', 'XOF', 'XAF', 'GBP']);

  // ---- helper pays -> zone CFA
  let normCountry = '';
  try {
    normCountry = String(countryHint || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  } catch {
    normCountry = String(countryHint || '').toLowerCase().trim();
  }
  

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
  // On détecte large: contient "CFA" ou "F CFA"
  const hasCFA =
    raw.includes('CFA') ||
    compact.includes('CFA') ||
    raw.includes('FRANC') && raw.includes('CFA');

  if (hasCFA) {
    return isCentralAfrica ? 'XAF' : 'XOF';
  }

  // 2) Déjà ISO propre
  if (KNOWN_ISO.has(raw)) return raw;

  // 3) Symboles directs
  if (raw === '€') return 'EUR';
  if (raw === '£') return 'GBP';
  if (raw === '$') return 'USD'; // par défaut

  // 4) "$CAD", "CAD$", "USD$", "US$" etc. -> on récupère 3 lettres si possibles
  if (lettersOnly.length === 3 && KNOWN_ISO.has(lettersOnly)) return lettersOnly;

  // 5) Fallback: si l'entrée est exactement 3 lettres (ISO inconnu), on renvoie quand même (option)
  // Si tu veux être ultra strict: retourne '' au lieu de raw.
  if (/^[A-Z]{3}$/.test(raw)) return raw;

  // ✅ sinon: on refuse le bruit
  return '';
}

module.exports = {
  normalizeCurrency,
};
