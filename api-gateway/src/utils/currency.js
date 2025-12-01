// File: src/utils/currency.js
'use strict';

/**
 * Normalise une devise en code ISO (EUR, USD, CAD, XOF, XAF…)
 * - Accepte symboles (€,$)
 * - Gère les variantes "F CFA" / "FCFA" / "CFA" → XOF par défaut (Afrique de l'Ouest)
 *
 * @param {string} input
 * @returns {string} code ISO upper-case ou chaîne vide
 */
function normalizeCurrency(input) {
  if (!input) return '';

  // Nettoyage
  const raw = String(input).trim().toUpperCase();
  const compact = raw.replace(/\s+/g, '');

  // 1️⃣ Cas "directs" déjà ISO
  if (['EUR', 'USD', 'CAD', 'XOF', 'XAF', 'GBP'].includes(raw)) return raw;

  // 2️⃣ Symboles simples
  if (raw === '€') return 'EUR';

  // Pour PayNoval, à adapter si tu veux que "$" = CAD
  if (raw === '$') return 'USD'; // ou 'CAD' si c'est ta logique business

  // 3️⃣ Variantes CFA → XOF (Afrique de l'Ouest : CI, SN, ML, BF, TG, BJ, NE, GW)
  const cfaKeywords = [
    'F CFA',
    'FCFA',
    'F.CFA',
    'FRANC CFA',
    'FRANCS CFA',
    'CFA',
  ];

  if (cfaKeywords.includes(raw) || cfaKeywords.includes(compact)) {
    // Par défaut, on mappe sur XOF
    return 'XOF';
  }

  // 4️⃣ Dernier fallback : on renvoie la version compactée (peut déjà être ISO)
  return compact;
}

module.exports = {
  normalizeCurrency,
};
