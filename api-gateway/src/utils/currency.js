// File: src/utils/currency.js
'use strict';

/**
 * Normalise une devise en code ISO (EUR, USD, CAD, XOF, XAF…)
 * - Accepte symboles (€,$)
 * - Gère les variantes "F CFA" / "FCFA" / "CFA" → XOF (Afrique de l'Ouest)
 * - Gère les variantes comme "$CAD", "CAD$", "USD$" → CAD, USD, etc.
 *
 * @param {string} input
 * @returns {string} code ISO upper-case ou chaîne vide
 */
function normalizeCurrency(input) {
  if (!input) return '';

  const raw = String(input).trim().toUpperCase(); // ex: "$CAD", "F CFA"
  const compact = raw.replace(/\s+/g, '');        // ex: "$CAD", "FCFA"
  const lettersOnly = raw.replace(/[^A-Z]/g, ''); // ex: "CAD" pour "$CAD"

  const KNOWN_ISO = ['EUR', 'USD', 'CAD', 'XOF', 'XAF', 'GBP'];

  // 1️⃣ CFA → XOF (avant tout le reste)
  const cfaKeywords = [
    'F CFA',
    'FCFA',
    'F.CFA',
    'FRANC CFA',
    'FRANCS CFA',
    'CFA',
  ];
  if (cfaKeywords.includes(raw) || cfaKeywords.includes(compact)) {
    return 'XOF';
  }

  // 2️⃣ Devise déjà propre
  if (KNOWN_ISO.includes(raw)) {
    return raw;
  }

  // 3️⃣ On essaie de récupérer seulement les lettres (cas "$CAD", "CAD$", "USD$")
  if (lettersOnly.length === 3 && KNOWN_ISO.includes(lettersOnly)) {
    return lettersOnly;
  }

  // 4️⃣ Symboles simples seuls
  if (raw === '€') return 'EUR';
  if (raw === '$') return 'USD'; // ou 'CAD' selon ta logique business

  // 5️⃣ Fallback : on renvoie juste les lettres (ça peut déjà être un code)
  return lettersOnly || compact;
}

module.exports = {
  normalizeCurrency,
};
