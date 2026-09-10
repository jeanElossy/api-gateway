"use strict";

/**
 * ============================================================================
 * AUCUNE DONNÉE DE CARTE EN CLAIR N'ENTRE DANS PAYNOVAL
 * ============================================================================
 *
 * ── Pourquoi ce contrôle est un MIDDLEWARE, et pourquoi il est monté PREMIER ─
 *
 * `validatePayment` valide avec `stripUnknown: true`. Un champ non déclaré au
 * schéma est donc RETIRÉ DU CORPS, en silence, sans erreur ni journal.
 *
 * Conséquence si le refus vivait dans le contrôleur : `cardNumber` et `cvc`
 * auraient déjà disparu quand il s'exécute. Le garde-fou n'aurait jamais rien
 * trouvé, aurait toujours passé, et aurait donné l'impression exacte de
 * protéger — pendant que le navigateur continuait d'émettre des numéros de
 * carte vers un point d'entrée public, et que ces numéros continuaient de
 * traverser les journaux d'accès et les traces d'erreur du réseau.
 *
 * Un contrôle placé après le nettoyage ne contrôle rien. Celui-ci voit le corps
 * BRUT, avant toute validation.
 *
 * ── Pourquoi refuser plutôt qu'ignorer ──────────────────────────────────────
 *
 * Un PAN qui transite met le serveur traversé dans le périmètre PCI-DSS :
 * l'attestation applicable passe de SAQ A à SAQ D, soit d'une trentaine de
 * contrôles à plus de trois cents, avec analyse de vulnérabilités trimestrielle
 * et test d'intrusion annuel.
 *
 * Stripe, Adyen et Checkout.com procèdent tous de la même façon : la carte va
 * du navigateur AU PRESTATAIRE, qui rend un jeton opaque. Le marchand ne voit
 * qu'un jeton. Refuser bruyamment est ce qui force la page publique à basculer
 * sur ce modèle, au lieu de la laisser émettre des PAN indéfiniment.
 */

const logger = require("../logger");

const CHAMPS_CARTE_INTERDITS = Object.freeze([
  "cardnumber",
  "card_number",
  "pan",
  "cvc",
  "cvv",
  "cvv2",
  "securitycode",
  "security_code",
  "expmonth",
  "exp_month",
  "expyear",
  "exp_year",
  "expirymonth",
  "expiryyear",
  "track2",
]);

function normaliserNomChamp(nom) {
  return String(nom || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
}

/**
 * Balaie à TOUTE PROFONDEUR.
 *
 * Un contrôle limité au premier niveau se contourne en emballant la donnée dans
 * un sous-objet — ce que faisait déjà l'adaptateur carte de Tx-Core, dont la
 * charge utile portait `source.pan`.
 */
function trouverChampCarte(valeur, profondeur = 0) {
  if (!valeur || typeof valeur !== "object" || profondeur > 6) return null;

  if (Array.isArray(valeur)) {
    for (const element of valeur) {
      const trouve = trouverChampCarte(element, profondeur + 1);
      if (trouve) return trouve;
    }
    return null;
  }

  for (const [cle, sousValeur] of Object.entries(valeur)) {
    if (CHAMPS_CARTE_INTERDITS.includes(normaliserNomChamp(cle))) return cle;
    const trouve = trouverChampCarte(sousValeur, profondeur + 1);
    if (trouve) return trouve;
  }

  return null;
}

function refuseRawCardData(req, res, next) {
  const champ = trouverChampCarte(req.body);

  if (!champ) return next();

  /**
   * ⚠️ ON JOURNALISE LE NOM DU CHAMP, JAMAIS SA VALEUR. Écrire
   * « cardNumber=4242… » pour expliquer qu'on refuse les numéros de carte
   * serait exactement la fuite qu'on ferme (règle B.4).
   */
  logger.error("[pay] donnée de carte en clair refusée", {
    champ,
    ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress,
    reqId: req.headers["x-request-id"] || null,
  });

  return res.status(400).json({
    success: false,
    code: "RAW_CARD_DATA_REFUSED",
    error:
      "PayNoval n'accepte pas les données de carte en clair. La carte doit " +
      "être transmise au prestataire depuis le navigateur, qui rend un jeton.",
  });
}

module.exports = refuseRawCardData;
module.exports.CHAMPS_CARTE_INTERDITS = CHAMPS_CARTE_INTERDITS;
module.exports.trouverChampCarte = trouverChampCarte;
