"use strict";

/**
 * ============================================================================
 * LE BORD NE DÉCIDE PLUS SI UN NUMÉRO DE DÉPÔT EST DE CONFIANCE
 * ============================================================================
 *
 * ── Le défaut que ce test empêche de revenir ────────────────────────────────
 *
 * `services/transactions/phoneSecurity.js` portait DEUX choses sous un seul
 * nom : une décision de sécurité sur le chemin de l'argent, et la plomberie
 * qui reconstruit les en-têtes sortants du proxy.
 *
 * La décision lisait `TrustedDepositNumber` dans la base DU BORD et refusait en
 * 403. Elle est partie dans TX Core le 2026-09-10, où vit le moteur qui déplace
 * l'argent (invariant 12).
 *
 * ── Pourquoi une garde, et pas seulement un déplacement ────────────────────
 *
 * Un déplacement se prouve par une PAIRE : présence à la destination, ABSENCE à
 * l'origine. Sans le second volet, rien n'empêche quelqu'un de « remettre le
 * contrôle au plus près du client » en toute bonne foi — et de rouvrir la
 * possibilité d'atteindre le moteur par un autre chemin sans être contrôlé.
 *
 * ── Ce qui reste légitimement au bord ──────────────────────────────────────
 *
 * `auditForwardHeaders` (19 appelants), `getUserId` (20) et la clé
 * d'idempotence. C'est de la traduction, pas de la décision : le moteur ne
 * proxifie rien et n'a aucun en-tête sortant à reconstruire.
 *
 * ── Comment il tombe ────────────────────────────────────────────────────────
 *
 * Réintroduire `enforceDepositPhoneTrust`, une lecture de `TrustedDepositNumber`
 * ou un `mongoose` dans `phoneSecurity.js` : l'assertion échoue en nommant la
 * chose réintroduite.
 *
 * Test **pur** : il lit des fichiers, n'ouvre aucune connexion, ne démarre
 * aucun serveur.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.resolve(__dirname, "..", "..");

function lire(...segments) {
  return fs.readFileSync(path.join(RACINE, ...segments), "utf8");
}

function existe(...segments) {
  return fs.existsSync(path.join(RACINE, ...segments));
}

/** On teste le code, pas ce qu'on en dit : commentaires retirés. */
function sansCommentaires(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const PHONE_SECURITY = sansCommentaires(
  lire("src", "services", "transactions", "phoneSecurity.js")
);

const ORCHESTRATEUR = sansCommentaires(
  lire("src", "services", "transactions", "transactionOrchestratorByFlow.js")
);

test("phoneSecurity ne porte plus la décision de confiance", () => {
  assert.ok(
    !/enforceDepositPhoneTrust/.test(PHONE_SECURITY),
    "`enforceDepositPhoneTrust` est revenu au bord. La décision appartient à " +
      "TX Core (`services/risk/depositPhoneTrust.js`) : un contrôle qui autorise " +
      "un mouvement d'argent doit vivre dans le service qui déplace l'argent."
  );
});

test("phoneSecurity n'ouvre plus aucune lecture en base", () => {
  assert.ok(
    !/TrustedDepositNumber/.test(PHONE_SECURITY),
    "`TrustedDepositNumber` est relu depuis le bord. Cette collection appartient " +
      "à TX Core depuis le 2026-09-10."
  );

  assert.ok(
    !/require\(\s*["']mongoose["']\s*\)/.test(PHONE_SECURITY),
    "`mongoose` est revenu dans phoneSecurity. Le bord ne possède aucun domaine : " +
      "il fait du TLS, du routage, de la vérification de jeton et de la corrélation."
  );
});

test("l'orchestrateur n'appelle plus le contrôle de confiance", () => {
  assert.ok(
    !/await\s+enforceDepositPhoneTrust\s*\(/.test(ORCHESTRATEUR),
    "L'orchestrateur du bord rappelle `enforceDepositPhoneTrust`. Le contrôle " +
      "est désormais sur la chaîne de `/initiate` de TX Core " +
      "(`middleware/requireTrustedDepositPhone`)."
  );
});

test("la plomberie du relais est INTACTE — on scinde, on ne vide pas", () => {
  /**
   * Le volet positif de la paire. Un test qui n'interdit que des choses finit
   * par pousser à tout supprimer : celui-ci exige que ce qui doit rester reste.
   */
  for (const garde of [
    "auditForwardHeaders",
    "getUserId",
    "pickIdempotencyHeader",
    "IDEMPOTENCY_HEADERS",
  ]) {
    assert.ok(
      new RegExp(`\\b${garde}\\b`).test(PHONE_SECURITY),
      `\`${garde}\` a disparu du bord. C'est de la TRADUCTION (reconstruction ` +
        "des en-têtes sortants du proxy), pas de la décision : elle reste ici, " +
        "et 19 appelants en dépendent."
    );
  }
});

test("les fichiers morts du bord ne sont pas revenus", () => {
  /**
   * Cinq fichiers formaient une grappe fermée autour d'une capacité montée
   * nulle part. Les recréer signifierait qu'on a rouvert une seconde
   * implémentation de la vérification de numéro — celle-là même qui existait
   * déjà en triple exemplaire.
   */
  const morts = [
    ["controllers", "phoneVerificationController.js"],
    ["src", "models", "TrustedDepositNumber.js"],
    ["src", "services", "twilioVerify.js"],
    ["src", "utils", "phone.js"],
    ["routes", "trustedDepositNumberRoutes.js"],
  ];

  for (const chemin of morts) {
    assert.ok(
      !existe(...chemin),
      `\`${chemin.join("/")}\` est de retour. La vérification de numéro de dépôt ` +
        "a UN seul propriétaire : TX Core. Le SMS a UN seul propriétaire : le " +
        "backend principal."
    );
  }
});

test("la route de vérification est un RELAIS, et elle est MONTÉE", () => {
  const route = sansCommentaires(lire("routes", "phoneVerificationRoutes.js"));
  const app = sansCommentaires(lire("src", "app.js"));

  assert.match(
    route,
    /relayerVers\(\s*["']\/api\/v1\/phone-verification["']\s*\)/,
    "La route ne relaie plus vers TX Core."
  );

  assert.ok(
    !/require\(.*phoneVerificationController/.test(route),
    "La route remonte un contrôleur natif. Le bord ne possède aucun domaine."
  );

  /**
   * ⚠️ L'ASSERTION QUI COMPTE LE PLUS.
   *
   * Le défaut d'origine n'était pas un mauvais code : c'était un routeur
   * PARFAITEMENT écrit que personne ne montait. Les trois appels que
   * l'application mobile fait déjà rendaient 404, et le 403 du contrôle de
   * dépôt citait des routes inexistantes comme chemin de sortie.
   *
   * Un fichier de route qui existe ne prouve rien. Seul son montage le prouve.
   */
  assert.match(
    app,
    /app\.use\(\s*["']\/api\/v1\/phone-verification["']\s*,\s*phoneVerificationRoutes\s*\)/,
    "`/api/v1/phone-verification` n'est monté nulle part. C'était EXACTEMENT le " +
      "défaut d'origine : le routeur existait, rien ne l'utilisait, et le mobile " +
      "prenait 404 sur les trois appels."
  );
});
