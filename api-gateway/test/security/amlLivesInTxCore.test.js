"use strict";

/**
 * ============================================================================
 * L'AML EST UNIQUE, ET IL VIT DANS TX-CORE
 * ============================================================================
 *
 * ── Le défaut que ce fichier empêche de revenir ─────────────────────────────
 *
 * Il a existé DEUX contrôles AML : 1 530 lignes dans la passerelle, 1 533 dans
 * Tx-Core, issues de la même souche et divergées de 1 234 lignes. Chaque
 * `POST /transactions/initiate` les traversait tous les deux, et lisait DEUX
 * FOIS le même document utilisateur — une fois par service, dans la même
 * requête.
 *
 * La divergence n'était pas théorique, elle était mesurée :
 *
 *   · le criblage sanctions n'existait QUE du côté bord ;
 *   · les contrôles d'éligibilité QUE du côté moteur ;
 *   · le retrait de `getMLScore` (qui renvoyait `Math.random() * 0.4`) avait
 *     été fait dans Tx-Core et jamais reporté au bord.
 *
 * Chacun recevait la moitié des correctifs. C'est le mode de défaillance
 * normal de deux implémentations d'une même règle.
 *
 * ── Pourquoi ce test teste les DEUX côtés ───────────────────────────────────
 *
 * ⚠️ Un déplacement ne se prouve pas en constatant l'absence à l'endroit qu'on
 * vide. Un test qui vérifie seulement « l'AML n'est plus au bord » passe au
 * vert le jour où quelqu'un supprime le contrôle des DEUX côtés.
 *
 * La preuve est une PAIRE : présence à la destination, absence à l'origine. Les
 * deux assertions doivent tenir ensemble, sinon le test ne mesure rien
 * (règle B.5).
 *
 * Test **pur** : il lit des fichiers, n'ouvre aucune connexion, ne démarre
 * aucun serveur.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BORD = path.resolve(__dirname, "..", "..");
const MOTEUR = path.resolve(BORD, "..", "..", "api-paynoval");

const moteurPresent = fs.existsSync(MOTEUR);

const sansCommentaires = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ══════════════════════════════════════════════════════════════════════════ */
/* 1. ABSENCE À L'ORIGINE — le bord ne décide plus de conformité             */
/* ══════════════════════════════════════════════════════════════════════════ */

const FICHIERS_RETIRES = Object.freeze([
  "src/middlewares/aml.js",
  "src/middlewares/publicCollectionAml.js",
  "src/services/aml.js",
  "src/services/sanctionsScreeningService.js",
  "src/tools/amlLimits.js",
  "src/models/AMLLog.js",
  "src/aml/blacklist.json",
  "controllers/adminCompliance.controller.js",
]);

for (const rel of FICHIERS_RETIRES) {
  test(`le bord n'a pas réintroduit ${rel}`, () => {
    assert.ok(
      !fs.existsSync(path.join(BORD, rel)),
      `${rel} est revenu au bord. L'AML doit rester unique : deux ` +
        "implémentations d'une règle de conformité ne restent pas d'accord."
    );
  });
}

test("aucune décision de conformité ne se reconstitue en pièces détachées", () => {
  /**
   * Supprimer les fichiers ne suffit pas : recopier trois fonctions dans un
   * middleware existant produirait le même défaut sans qu'aucun fichier
   * interdit ne réapparaisse.
   */
  const DECISIONS = [
    "getSingleTxLimit",
    "getDailyLimit",
    "getUserTransactionsStats",
    "screenTransactionCounterparties",
    "findBlacklistHit",
    "getPEPOrSanctionedStatus",
  ];

  const coupables = [];

  const parcourir = (dir) => {
    for (const entree of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entree.name === "node_modules" || entree.name.startsWith(".")) continue;

      const complet = path.join(dir, entree.name);

      if (entree.isDirectory()) {
        parcourir(complet);
        continue;
      }

      if (!entree.name.endsWith(".js")) continue;

      const rel = path.relative(BORD, complet);
      if (rel.startsWith("test" + path.sep)) continue;

      const code = sansCommentaires(fs.readFileSync(complet, "utf8"));

      for (const decision of DECISIONS) {
        if (code.includes(decision)) coupables.push(`${rel} → ${decision}`);
      }
    }
  };

  for (const racine of ["src", "routes", "controllers"]) {
    const complet = path.join(BORD, racine);
    if (fs.existsSync(complet)) parcourir(complet);
  }

  assert.deepEqual(
    coupables,
    [],
    "une décision de conformité est réapparue au bord :\n  " +
      coupables.join("\n  ")
  );
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 2. PRÉSENCE À LA DESTINATION — sans quoi ce fichier ne mesure rien        */
/* ══════════════════════════════════════════════════════════════════════════ */

test("Tx-Core porte bien l'AML unique, criblage compris", { skip: !moteurPresent ? "dépôt api-paynoval absent de ce checkout" : false }, () => {
  const aml = sansCommentaires(
    fs.readFileSync(path.join(MOTEUR, "src", "middleware", "aml.js"), "utf8")
  );

  /** Le criblage, descendu du bord le 2026-09-10. */
  assert.match(aml, /screenTransactionCounterparties/);
  assert.match(aml, /SANCTIONS_SCREENING_BLOCKED/);
  assert.match(aml, /COMPLIANCE_REVIEW_REQUIRED/);

  /** Les plafonds, qui étaient appliqués en triple. */
  assert.match(aml, /getSingleTxLimit\(/);
  assert.match(aml, /getDailyLimit\(/);

  /** Les listes et la porte PEP, qui existaient des deux côtés. */
  assert.match(aml, /findBlacklistHit\(/);
  assert.match(aml, /PEP_SANCTIONED/);

  assert.ok(
    fs.existsSync(
      path.join(MOTEUR, "src", "services", "risk", "sanctionsScreening.js")
    ),
    "le service de criblage n'est pas arrivé dans Tx-Core"
  );
});

test("Tx-Core monte l'AML sur la route qui initie un virement", { skip: !moteurPresent ? "dépôt api-paynoval absent de ce checkout" : false }, () => {
  const routes = sansCommentaires(
    fs.readFileSync(
      path.join(MOTEUR, "src", "routes", "transactionsRoutes.js"),
      "utf8"
    )
  );

  assert.match(routes, /require\(["']\.\.\/middleware\/aml["']\)/);
  assert.match(routes, /\n\s*amlMiddleware,/);
});

test("Tx-Core monte l'AML public sur la route d'encaissement", { skip: !moteurPresent ? "dépôt api-paynoval absent de ce checkout" : false }, () => {
  /**
   * Le contrôle du chemin public a gagné en portée en descendant : il
   * s'applique désormais à TOUT appelant de `/api/v1/collections/initiate`, et
   * plus seulement au trafic de `/api/v1/pay`.
   */
  const routes = sansCommentaires(
    fs.readFileSync(
      path.join(MOTEUR, "src", "routes", "collectionRoutes.js"),
      "utf8"
    )
  );

  assert.match(routes, /publicCollectionAml/);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 3. CE QUI DOIT RESTER AU BORD — l'autre moitié de la régression possible  */
/* ══════════════════════════════════════════════════════════════════════════ */

test("le bord garde les deux contrôles que Tx-Core ne peut PAS rendre", () => {
  /**
   * · la limite par ADRESSE IP — Tx-Core ne voit que l'adresse de la
   *   passerelle, jamais celle du payeur ;
   * · le refus des données de carte en clair, qui doit intervenir avant
   *   `validatePayment` et son `stripUnknown: true`, lequel effacerait
   *   `cardNumber`/`cvc` EN SILENCE.
   *
   * Les emporter avec l'AML serait la régression silencieuse de ce
   * déplacement : rien ne l'aurait signalée, et le paiement aboutirait.
   */
  const route = fs.readFileSync(path.join(BORD, "routes", "payment.js"), "utf8");

  assert.match(route, /publicCollectionLimiter/);
  assert.match(route, /refuseRawCardData/);
  assert.ok(fs.existsSync(path.join(BORD, "src", "middlewares", "refuseRawCardData.js")));
});
