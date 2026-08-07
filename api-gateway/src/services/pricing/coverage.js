"use strict";

/**
 * ENREGISTREMENT DES CORRIDORS NON COUVERTS
 * -----------------------------------------------------------------------------
 * `recordCoverageGap` ne doit JAMAIS faire échouer un devis : elle est appelée
 * hors du chemin de réponse et absorbe ses propres erreurs. Un incident de
 * journalisation ne peut pas empêcher un client d'obtenir un prix.
 */

const PricingCoverageGap = require("../../models/PricingCoverageGap");

const norm = (v, fallback = "ALL") => {
  const s = String(v ?? "").trim().toUpperCase();
  return s || fallback;
};

/**
 * Clé stable d'un périmètre. Le MONTANT n'y entre pas : ce qui manque est le
 * corridor, pas une tranche de montant.
 *
 * @returns {string}
 */
function coverageKey(request = {}) {
  return [
    norm(request.txType),
    norm(request.method),
    norm(request.provider),
    norm(request.fromCurrency),
    norm(request.toCurrency),
    norm(request.fromCountry),
    norm(request.toCountry),
  ].join("|");
}

/**
 * Consigne un échec de matching. Ne lève jamais.
 * @returns {Promise<void>}
 */
async function recordCoverageGap(request = {}) {
  try {
    const key = coverageKey(request);
    const now = new Date();

    await PricingCoverageGap.updateOne(
      { key },
      {
        $set: { request, lastSeenAt: now, resolvedAt: null },
        $setOnInsert: { firstSeenAt: now },
        $inc: { occurrences: 1 },
      },
      { upsert: true }
    );
  } catch (err) {
    // Volontairement silencieux : voir l'en-tête du fichier.
    console.warn(
      "[pricing] échec d'enregistrement d'un corridor non couvert :",
      err?.message
    );
  }
}

module.exports = { coverageKey, recordCoverageGap };
