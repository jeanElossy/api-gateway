// File: api-gateway/routes/payment.js
"use strict";

const express = require("express");
const router = express.Router();

const refuseRawCardData = require("../src/middlewares/refuseRawCardData");
const validatePayment = require("../src/middlewares/validatePayment");
const { publicCollectionLimiter } = require("../src/middlewares/rateLimit");
const { handlePayment } = require("../controllers/paymentController");

/**
 * POST /api/v1/pay — contribution à une cagnotte depuis un lien public.
 *
 * ⚠️ L'ORDRE DE CES QUATRE ÉTAGES EST UN INVARIANT, pas une préférence.
 *
 *   1. `publicCollectionLimiter` — la SEULE limite qui voit l'adresse réelle du
 *      payeur. Tx-Core exempte ce chemin de la sienne, faute de mieux : il ne
 *      voit que l'adresse de la passerelle.
 *   2. `refuseRawCardData` — voit le corps BRUT. Doit passer avant la
 *      validation : `validatePayment` valide avec `stripUnknown: true` et
 *      retirerait `cardNumber`/`cvc` EN SILENCE, rendant aveugle tout contrôle
 *      placé après lui.
 *   3. `validatePayment`   — forme et périmètre du rail.
 *   4. `handlePayment`     — relais vers Tx-Core. Ne calcule rien, n'écrit rien.
 *
 * ── Où est passé le contrôle AML ────────────────────────────────────────────
 *
 * `publicCollectionAml` occupait le quatrième étage jusqu'au 2026-09-10. Il vit
 * désormais dans `api-paynoval/src/middleware/publicCollectionAml.js`, monté
 * sur `POST /api/v1/collections/initiate`, c'est-à-dire sur la route même qui
 * crée l'intention d'encaissement.
 *
 * Le déplacement n'affaiblit rien et élargit la couverture : le plafond et le
 * criblage s'appliquent maintenant à TOUT appelant de cette route, pas au seul
 * trafic qui passe par `/api/v1/pay`. Le jour où un partenaire ou un
 * back-office l'atteindra, il sera criblé sans que personne ait à y penser.
 *
 * Ce qui RESTE au bord est ce que seul le bord peut faire : la limite par
 * adresse IP — Tx-Core ne voit que l'adresse de la passerelle — et le refus des
 * données de carte en clair, qui doit intervenir avant toute validation.
 *
 * Verrouillé par `test/security/publicCollectionPath.test.js` et
 * `test/security/amlLivesInTxCore.test.js`.
 */
router.post(
  "/",
  publicCollectionLimiter,
  refuseRawCardData,
  validatePayment,
  handlePayment
);

module.exports = router;
