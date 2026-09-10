"use strict";

/**
 * ============================================================================
 * UN RAPPEL PRESTATAIRE SE RELAIE EN OCTETS, VERS LE CHEMIN QUI EXISTE
 * ============================================================================
 *
 * ── Les trois défauts que ces tests empêchent de revenir ────────────────────
 *
 * 1. **La re-sérialisation du corps.** Le contrôleur transmettait
 *    `data: req.body` — un objet désérialisé par `express.json()`, qu'axios
 *    re-sérialisait. Les octets signés par le prestataire étaient perdus, donc
 *    le HMAC recalculé par TX Core portait sur une chaîne différente. Une
 *    signature vérifie des OCTETS ; tout ce qui les touche la casse.
 *
 * 2. **Le chemin inexistant.** Il postait sur `/webhooks/mobilemoney`, alors
 *    que TX Core ne monte que `/webhooks/providers/:rail/:provider`
 *    (`api-paynoval/src/server.js:1239`). Tout rappel recevait un 404.
 *
 * 3. **La liste d'en-têtes devinée.** Trois en-têtes de signature étaient
 *    recopiés à la main (`stripe-signature`, `x-signature`,
 *    `x-paynoval-signature`) ; les adaptateurs de TX Core en attendent
 *    d'autres (`x-wave-signature`, `x-visa-timestamp`…). Aucun ne passait.
 *
 * ── Pourquoi ces tests sont PURS ────────────────────────────────────────────
 *
 * Ils n'ouvrent aucune connexion et ne démarrent aucun serveur : ils lisent la
 * source pour l'ordre de montage (une propriété de STRUCTURE), et appellent la
 * fonction d'en-têtes directement pour le reste (une propriété de RÉSULTAT).
 * C'est ce qui les rend exécutables à chaque poussée.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.resolve(__dirname, "../..");

function lire(...segments) {
  return fs.readFileSync(path.join(RACINE, ...segments), "utf8");
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 1. Le corps brut                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

test("express.raw est monté sur /api/v1/provider-webhooks AVANT express.json", () => {
  const app = lire("src", "app.js");

  const posRaw = app.indexOf('"/api/v1/provider-webhooks",\n  express.raw(');
  const posJson = app.indexOf("app.use(express.json(");

  assert.notEqual(
    posRaw,
    -1,
    "`express.raw()` n'est plus monté sur /api/v1/provider-webhooks. Sans lui, " +
      "`express.json()` désérialise le rappel et les octets signés par le " +
      "prestataire sont perdus : la signature devient invérifiable."
  );

  assert.ok(
    posRaw < posJson,
    "`express.raw()` doit précéder `express.json()`. Le premier parseur qui " +
      "consomme le flux gagne ; monté après, il n'a plus rien à lire et le " +
      "corps repart désérialisé."
  );
});

test("le contrôleur ne transmet jamais un corps désérialisé", () => {
  const ctrl = lire("controllers", "providerWebhooksController.js");
  const sansCommentaires = ctrl
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.doesNotMatch(
    sansCommentaires,
    /data:\s*req\.body\b/,
    "`data: req.body` transmet un objet, qu'axios re-sérialise. Le rappel doit " +
      "partir tel qu'il est arrivé : `data: corpsBrut(req)`, un Buffer."
  );

  assert.match(
    sansCommentaires,
    /transformRequest/,
    "Sans `transformRequest: [(d) => d]`, axios inspecte `data` et peut le " +
      "transformer. On veut un transport d'octets, pas une sérialisation."
  );

  assert.match(
    sansCommentaires,
    /Buffer\.isBuffer/,
    "Le contrôleur doit VÉRIFIER que le corps est bien brut et lever sinon " +
      "(règle B.2). Transmettre un corps non brut produirait un rappel dont la " +
      "signature ne peut pas être vérifiée, et l'incident serait attribué au " +
      "prestataire plutôt qu'à nous."
  );
});

/* ────────────────────────────────────────────────────────────────────────── */
/* 2. Le chemin visé                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

test("le chemin visé est celui que TX Core sert réellement", () => {
  const ctrl = lire("controllers", "providerWebhooksController.js");
  const sansCommentaires = ctrl
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.match(
    sansCommentaires,
    /\/webhooks\/providers\//,
    "TX Core monte `/webhooks/providers/:rail/:provider` et RIEN d'autre " +
      "(api-paynoval/src/server.js:1239). Viser `/webhooks/<rail>` rend un 404 " +
      "sur chaque rappel."
  );

  assert.doesNotMatch(
    sansCommentaires,
    /`\$\{[^}]*\}\/webhooks\/(mobilemoney|visa-direct)`/,
    "Les anciens chemins `/webhooks/mobilemoney` et `/webhooks/visa-direct` " +
      "ne sont servis nulle part."
  );
});

test("les deux routes héritées sans opérateur échouent en FERMETURE", () => {
  const routes = lire("routes", "providerWebhookRoutes.js");

  assert.match(routes, /router\.post\("\/mobilemoney"/);
  assert.match(routes, /router\.post\("\/visa-direct"/);

  const posHerite = routes.indexOf('router.post("/mobilemoney"');
  const posCanonique = routes.indexOf('router.post("/:rail/:provider"');

  assert.notEqual(
    posCanonique,
    -1,
    "Le chemin canonique `/:rail/:provider` doit exister : c'est le seul qui " +
      "porte l'opérateur, donc le seul qui permette de choisir le bon secret."
  );

  assert.ok(
    posHerite < posCanonique,
    "Les chemins hérités doivent être déclarés AVANT `/:rail/:provider`, sinon " +
      "Express fait correspondre `/mobilemoney` à `/:rail` et le relais cherche " +
      "un opérateur qui n'a pas été fourni."
  );
});

/* ────────────────────────────────────────────────────────────────────────── */
/* 3. Les en-têtes                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL =
  process.env.SERVICE_PAYNOVAL_URL || "http://localhost:1";

const {
  construireEnTetes,
  RAILS,
} = require("../../controllers/providerWebhooksController");

function requete(headers) {
  return { headers, id: "req-test" };
}

test("tout en-tête de signature traverse, quel que soit son nom", () => {
  /**
   * Les noms ci-dessous sont ceux qu'attendent réellement les adaptateurs de
   * TX Core (`waveAdapter.js:233`, `visaDirectAdapter.js:230`). Aucun ne
   * figurait dans l'ancienne liste recopiée à la main.
   */
  const entrants = {
    "x-wave-signature": "sig-wave",
    "x-wave-timestamp": "1757000000",
    "x-visa-signature": "sig-visa",
    "x-visa-timestamp": "1757000001",
    "x-signature": "sig-generique",
    "x-timestamp": "1757000002",
    "x-un-operateur-futur-signature": "sig-inconnue",
  };

  const sortants = construireEnTetes(requete(entrants), {
    rail: "mobilemoney",
    provider: "wave",
  });

  for (const [nom, valeur] of Object.entries(entrants)) {
    assert.equal(
      sortants[nom],
      valeur,
      `L'en-tête « ${nom} » n'est pas relayé. On relaie TOUT sauf ce qui est ` +
        "spécifique au saut réseau : une liste d'en-têtes à recopier est une " +
        "liste qu'on oublie de compléter quand un opérateur arrive."
    );
  }
});

test("les en-têtes de saut réseau ne sont pas recopiés", () => {
  const sortants = construireEnTetes(
    requete({
      host: "api-gateway.exemple",
      "content-length": "999",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "x-wave-signature": "sig",
    }),
    { rail: "mobilemoney", provider: "wave" }
  );

  for (const interdit of ["host", "content-length", "connection", "transfer-encoding"]) {
    assert.equal(
      sortants[interdit],
      undefined,
      `« ${interdit} » décrit la connexion prestataire → gateway. Le recopier ` +
        "décrirait faussement la connexion gateway → TX Core ; `content-length` " +
        "en particulier tronquerait le corps si celui-ci différait d'un octet."
    );
  }

  assert.equal(sortants["x-wave-signature"], "sig", "La signature, elle, passe.");
});

test("un appelant ne peut pas se fabriquer un jeton interne", () => {
  const sortants = construireEnTetes(
    requete({
      "x-internal-token": "jeton-forge-par-un-tiers",
      "x-paynoval-internal-token": "autre-forgerie",
      authorization: "Bearer vole",
      "x-forwarded-service": "je-suis-le-gateway",
    }),
    { rail: "card", provider: "visa_direct" }
  );

  assert.notEqual(
    sortants["x-internal-token"],
    "jeton-forge-par-un-tiers",
    "GRAVE : le jeton interne présenté par l'appelant serait relayé tel quel à " +
      "un service interne. Cette route est PUBLIQUE et non authentifiée — " +
      "n'importe qui pourrait ainsi parler à TX Core avec un jeton de son choix."
  );

  assert.equal(sortants["x-paynoval-internal-token"], undefined);
  assert.equal(sortants.authorization, undefined);
  assert.equal(
    sortants["x-forwarded-service"],
    "api-gateway",
    "`x-forwarded-service` est posé par le gateway, jamais accepté de l'extérieur."
  );
});

test("le rail et l'opérateur sont annoncés à TX Core", () => {
  const sortants = construireEnTetes(requete({}), {
    rail: "mobilemoney",
    provider: "orange",
  });

  assert.equal(sortants["x-webhook-rail"], "mobilemoney");
  assert.equal(sortants["x-webhook-provider"], "orange");
});

/* ────────────────────────────────────────────────────────────────────────── */
/* 4. La table des rails reste close                                          */
/* ────────────────────────────────────────────────────────────────────────── */

test("la table des rails est close et alignée sur le périmètre produit", () => {
  assert.deepEqual(
    Object.keys(RAILS).sort(),
    ["card", "mobilemoney"],
    "Périmètre arrêté le 2026-09-08 : trois rails, dont l'interne PayNoval qui " +
      "ne reçoit AUCUN rappel externe. Ajouter un rail ici sans adaptateur " +
      "correspondant dans TX Core ouvrirait un chemin sans vérification possible."
  );

  assert.deepEqual(
    [...RAILS.mobilemoney].sort(),
    ["moov", "mtn", "orange", "wave"],
    "Doit rester aligné sur `MOBILEMONEY_PROVIDERS` de providerRegistry.js."
  );

  assert.deepEqual([...RAILS.card], ["visa_direct"]);
});
