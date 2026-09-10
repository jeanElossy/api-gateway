"use strict";

/**
 * ============================================================================
 * LE CHEMIN D'ENCAISSEMENT PUBLIC — CE QUI DOIT RESTER VRAI
 * ============================================================================
 *
 * `POST /api/v1/pay` sert la contribution à une cagnotte depuis un lien public :
 * un payeur SANS COMPTE, par mobile money ou par carte.
 *
 * Ce chemin était rompu en QUATRE endroits indépendants, ce qui explique qu'il
 * n'ait jamais fonctionné de bout en bout :
 *
 *   1. il visait `${SERVICE_PAYNOVAL_URL}/pay`, route de Tx-Core RETIRÉE le
 *      2026-09-03 (410) parce qu'elle déplaçait de l'argent hors du grand livre ;
 *   2. `middlewares/aml.js` rendait 401 quand `req.user` était absent —
 *      c'est-à-dire à chaque contribution publique, par construction ;
 *   3. rien n'appelait jamais `collect()` : la capacité d'encaisser était
 *      entièrement écrite et entièrement morte ;
 *   4. la cagnotte était créditée sur un 2xx du prestataire, avant que l'argent
 *      existe (règle B.3).
 *
 * Chacun masquait les suivants. Ce fichier verrouille les quatre à la fois.
 *
 * Tests **purs** : lecture de fichiers et appels de fonctions pures. Aucun
 * serveur, aucune connexion.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RACINE = path.resolve(__dirname, "..", "..");

function lire(...segments) {
  return fs.readFileSync(path.join(RACINE, ...segments), "utf8");
}

function sansCommentaires(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const ROUTE = sansCommentaires(lire("routes", "payment.js"));
const CONTROLEUR = sansCommentaires(lire("controllers", "paymentController.js"));
const VALIDATION = sansCommentaires(
  lire("src", "middlewares", "validatePayment.js")
);

/* ══════════════════════════════════════════════════════════════════════════ */
/* 1. AUCUNE DONNÉE DE CARTE EN CLAIR                                        */
/* ══════════════════════════════════════════════════════════════════════════ */

const refuseRawCardData = require("../../src/middlewares/refuseRawCardData");

test("le refus des données de carte est monté AVANT la validation", () => {
  /**
   * ⚠️ L'ORDRE EST LE TEST. `validatePayment` valide avec `stripUnknown: true`
   * et retire les champs non déclarés SANS ERREUR NI JOURNAL. Un refus placé
   * après lui ne verrait jamais `cardNumber` : il passerait toujours, en
   * donnant l'impression exacte de protéger, pendant que la page publique
   * continuerait d'émettre des numéros de carte.
   */
  const posRefus = ROUTE.indexOf("refuseRawCardData");
  const posValidation = ROUTE.indexOf("validatePayment");

  assert.ok(posRefus > -1, "refuseRawCardData doit être monté");
  assert.ok(posValidation > -1, "validatePayment doit être monté");

  const ordre = ROUTE.slice(ROUTE.indexOf("router.post("));
  assert.ok(
    ordre.indexOf("refuseRawCardData") < ordre.indexOf("validatePayment"),
    "refuseRawCardData doit précéder validatePayment dans router.post"
  );
});

test("un numéro de carte est trouvé à n'importe quelle profondeur", () => {
  const { trouverChampCarte } = refuseRawCardData;

  assert.equal(trouverChampCarte({ cardNumber: "4242" }), "cardNumber");
  assert.equal(trouverChampCarte({ source: { pan: "4242" } }), "pan");
  assert.equal(trouverChampCarte({ a: { b: { c: { cvc: "123" } } } }), "cvc");
  assert.equal(trouverChampCarte({ items: [{ card_number: "4242" }] }), "card_number");
  assert.equal(trouverChampCarte({ "card-number": "4242" }), "card-number");
  assert.equal(trouverChampCarte({ amount: 10, donorName: "Awa" }), null);
});

test("le refus ne journalise jamais la VALEUR du champ", () => {
  const src = lire("src", "middlewares", "refuseRawCardData.js");
  const nu = sansCommentaires(src);

  /**
   * Journaliser « cardNumber=4242… » pour expliquer qu'on refuse les numéros de
   * carte serait précisément la fuite qu'on ferme (règle B.4).
   */
  assert.doesNotMatch(nu, /logger\.\w+\([^)]*req\.body/);
  assert.match(nu, /champ,/);
});

test("le schéma carte exige un JETON et ne déclare aucun champ de carte", () => {
  assert.match(VALIDATION, /cardToken:\s*Joi\.string\(\)[\s\S]{0,80}\.required\(\)/);

  const schemaCarte = VALIDATION.slice(
    VALIDATION.indexOf("const visaDirectSchema"),
    VALIDATION.indexOf("const SCHEMAS")
  );

  for (const interdit of ["cardNumber", "cvc", "expMonth", "expYear"]) {
    assert.ok(
      !schemaCarte.includes(interdit),
      `Le schéma carte ne doit pas déclarer ${interdit} : avec stripUnknown, ` +
        "le déclarer pour le rejeter est redondant, et l'oublier est invisible."
    );
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 2. LE CONTRÔLE AML NE PEUT PAS EXIGER UN COMPTE                           */
/* ══════════════════════════════════════════════════════════════════════════ */

test("le chemin public n'appelle AUCUN AML au bord", () => {
  /**
   * ⚠️ CET INVARIANT A CHANGÉ DE FORME LE 2026-09-10 — lire avant de corriger.
   *
   * Il exigeait auparavant que `routes/payment.js` monte `publicCollectionAml`
   * et surtout PAS `middlewares/aml.js`, lequel sort en 401 AUTH_REQUIRED quand
   * `req.user` est absent : sur un chemin dont tous les appelants sont anonymes
   * par construction, cela refusait 100 % des contributions.
   *
   * Les deux AML du bord ont été fusionnés dans Tx-Core. Le contrôle du chemin
   * public vit désormais dans `api-paynoval/src/middleware/publicCollectionAml.js`,
   * monté sur `POST /api/v1/collections/initiate`, c'est-à-dire sur la route qui
   * crée l'intention d'encaissement — donc devant TOUT appelant, pas seulement
   * devant `/api/v1/pay`.
   *
   * Ce que ce test défend maintenant : qu'aucune décision de conformité ne
   * revienne au bord, et que ce qui DOIT y rester y reste.
   */
  assert.ok(
    !/require\(["'][^"']*middlewares\/(public)?[Cc]ollection[Aa]ml["']\)/.test(ROUTE),
    "routes/payment.js ne doit monter aucun AML : il vit dans Tx-Core"
  );

  assert.ok(
    !/require\(["'][^"']*middlewares\/aml["']\)/.test(ROUTE),
    "routes/payment.js ne doit pas monter middlewares/aml (401 sans compte)"
  );
});

test("ce qui ne peut se faire QU'au bord y reste", () => {
  /**
   * Le déplacement de l'AML ne doit pas emporter les deux contrôles que Tx-Core
   * est structurellement incapable de rendre :
   *
   *   · la limite par ADRESSE IP — Tx-Core ne voit que l'adresse de la
   *     passerelle, jamais celle du payeur ;
   *   · le refus des données de carte en clair, qui doit intervenir AVANT
   *     `validatePayment` et son `stripUnknown: true`.
   *
   * Les perdre en même temps que l'AML serait la régression silencieuse de ce
   * déplacement.
   */
  assert.match(ROUTE, /publicCollectionLimiter/);
  assert.match(ROUTE, /refuseRawCardData/);

  const posLimiteur = ROUTE.indexOf("publicCollectionLimiter,");
  const posCarte = ROUTE.indexOf("refuseRawCardData,");
  const posValidation = ROUTE.indexOf("validatePayment,");

  assert.ok(posLimiteur > -1 && posCarte > -1 && posValidation > -1);
  assert.ok(
    posLimiteur < posCarte && posCarte < posValidation,
    "l'ordre limiteur → refus carte → validation est un invariant, pas un goût"
  );
});

test("le contrôle AML du chemin public existe bien dans Tx-Core", () => {
  /**
   * Un déplacement ne se prouve pas en constatant l'absence à l'endroit qu'on
   * vide : il se prouve en constatant la PRÉSENCE à l'endroit qu'on remplit.
   * Sans cette assertion, supprimer le contrôle des deux côtés ferait passer la
   * suite au vert.
   */
  const moteur = path.join(RACINE, "..", "..", "api-paynoval");

  if (!fs.existsSync(moteur)) return;

  const src = fs.readFileSync(
    path.join(moteur, "src", "middleware", "publicCollectionAml.js"),
    "utf8"
  );

  assert.match(src, /PUBLIC_COLLECTION_LIMIT/);
  assert.match(src, /SCREENING_UNAVAILABLE/);
  assert.match(src, /status\(503\)/);
  assert.doesNotMatch(sansCommentaires(src), /Infinity/);

  const route = fs.readFileSync(
    path.join(moteur, "src", "routes", "collectionRoutes.js"),
    "utf8"
  );

  assert.match(route, /publicCollectionAml/);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 3. LE CONTRÔLEUR EST UNE PASSERELLE, PAS UN MOTEUR                        */
/* ══════════════════════════════════════════════════════════════════════════ */

test("la passerelle ne calcule plus de frais", () => {
  /**
   * `computeDynamicFees` appliquait 0,5 % codés en dur, en contournant le
   * moteur de tarification de cette même passerelle. Deux barèmes pour un même
   * produit divergent toujours, et celui qui est écrit en dur dans un
   * contrôleur gagne sans que personne ne sache pourquoi.
   */
  assert.ok(!CONTROLEUR.includes("computeDynamicFees"));
  assert.doesNotMatch(CONTROLEUR, /0\.005/);
  assert.doesNotMatch(CONTROLEUR, /gatewayFee/);
});

test("la passerelle ne crédite plus aucune cagnotte sur une réponse HTTP", () => {
  /**
   * `notifyCagnotteExternalContribution` appelait le backend en fire-and-forget
   * avec `status: "succeeded"` CODÉ EN DUR, dès que le prestataire rendait 2xx.
   * Or un 2xx de collecte veut dire « j'ai accepté de prélever », pas « j'ai
   * prélevé » : en mobile money, le client n'a pas encore saisi son code
   * (règle B.3).
   */
  assert.ok(!CONTROLEUR.includes("notifyCagnotteExternalContribution"));
  assert.ok(!CONTROLEUR.includes("external-payment-callback"));
  assert.doesNotMatch(CONTROLEUR, /status:\s*["']succeeded["']/);
});

test("la cible est l'encaissement de Tx-Core, jamais la route /pay retirée", () => {
  assert.match(CONTROLEUR, /\/api\/v1\/collections\/initiate/);

  /**
   * `${config.microservices.X}/pay` visait la route Tx-Core fermée en 410 le
   * 2026-09-03. Y revenir rendrait le chemin muet à nouveau.
   */
  assert.doesNotMatch(CONTROLEUR, /PROVIDER_TO_ENDPOINT/);
  assert.doesNotMatch(CONTROLEUR, /\$\{[^}]*\}\/pay["'`]/);
});

test("une clé d'idempotence absente est REFUSÉE, jamais inventée", () => {
  const { cleIdempotence } = require("../../controllers/paymentController");

  assert.equal(cleIdempotence({ headers: { "idempotency-key": "abc12345" } }), "abc12345");
  assert.equal(cleIdempotence({ headers: { "X-Idempotency-Key": "def67890" } }), "def67890");
  assert.equal(cleIdempotence({ headers: { "idempotency-key": ["k1", "k2"] } }), "k1");
  assert.equal(cleIdempotence({ headers: {} }), "");

  /**
   * Une clé tirée au hasard côté serveur serait différente à chaque requête :
   * aucune idempotence, présentée comme telle. Sur une page publique, un double
   * clic prélèverait deux fois le payeur.
   */
  assert.match(CONTROLEUR, /IDEMPOTENCY_KEY_REQUIRED/);
  assert.doesNotMatch(
    CONTROLEUR.slice(CONTROLEUR.indexOf("function cleIdempotence")),
    /randomUUID/
  );
});

test("Tx-Core injoignable ne rend jamais 200", () => {
  /**
   * Acquitter un encaissement qui n'a peut-être pas été demandé ferait afficher
   * un remerciement pour un paiement inexistant, et empêcherait le rejeu.
   */
  assert.match(CONTROLEUR, /status\(timeout \? 504 : 502\)/);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 4. LE RAIL NE SE DEVINE PAS                                               */
/* ══════════════════════════════════════════════════════════════════════════ */

test("la table des rails est close et alignée sur Tx-Core", () => {
  const { resolverRail, OPERATEURS_MOBILE_MONEY } = require("../../controllers/paymentController");

  assert.deepEqual([...OPERATEURS_MOBILE_MONEY].sort(), ["moov", "mtn", "orange", "wave"]);

  assert.deepEqual(resolverRail({ provider: "mobilemoney", operator: "wave" }), {
    rail: "mobilemoney",
    provider: "wave",
  });

  assert.deepEqual(resolverRail({ provider: "visa_direct" }), {
    rail: "card",
    provider: "visa_direct",
  });

  /** Un opérateur absent NE SE DEVINE PAS : le rail désigne le compte de
   * compensation d'entrée, donc le relevé prestataire du rapprochement. */
  assert.equal(resolverRail({ provider: "mobilemoney" }).erreur, "UNKNOWN_PROVIDER");
  assert.equal(resolverRail({ provider: "flutterwave" }).erreur, "UNKNOWN_RAIL");
  assert.equal(resolverRail({}).erreur, "UNKNOWN_RAIL");

  /**
   * Le rail PayNoval a son propre chemin, qui débite un portefeuille et écrit
   * au grand livre. L'ouvrir ici créerait un SECOND chemin vers le même argent.
   */
  assert.equal(
    resolverRail({ provider: "paynoval" }).erreur,
    "PAYNOVAL_RAIL_HAS_ITS_OWN_PATH"
  );
});

test("une configuration Tx-Core absente échoue en FERMETURE", () => {
  assert.match(CONTROLEUR, /COLLECTION_UNCONFIGURED/);
  assert.match(CONTROLEUR, /status\(503\)/);
});
