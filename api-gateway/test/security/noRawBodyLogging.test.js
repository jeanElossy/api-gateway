"use strict";

/**
 * ============================================================================
 * AUCUN CORPS DE REQUÊTE NE SE JOURNALISE SANS MASQUAGE
 * ============================================================================
 *
 * ── Ce que ce test empêche de revenir ────────────────────────────────────────
 * `transactionOrchestratorByFlow.js` journalisait `req.body` intégralement à
 * l'entrée de `/initiate`. Le corps d'un `/initiate` porte la **réponse à la
 * question de sécurité** en clair ; celui d'un `/confirm`, le code de
 * confirmation. Ce sont les deux valeurs qu'un audit de journal interdit
 * d'écrire (règle B.4).
 *
 * `src/utils/redactSensitive.js` avait été écrit **exactement pour ça** — son
 * en-tête le dit — et n'était importé **nulle part**. Le module existait, la
 * fuite aussi. C'est le mode de défaillance le plus coûteux : une protection
 * qu'on croit en place parce qu'on se souvient de l'avoir écrite.
 *
 * ── Pourquoi « c'est muet en production » ne suffisait pas ──────────────────
 * `SILENCE_PROD_LOGS` réduit `console.log` au silence en production. Mais un
 * secret protégé par un INTERRUPTEUR n'est pas protégé : il suffit qu'on relève
 * le niveau de journal une heure pour diagnostiquer un incident — c'est-à-dire
 * précisément le moment où on le fait. Et le garde-fou ne couvre pas
 * `console.error`, donc le chemin d'ERREUR écrivait déjà en production.
 *
 * ── Pourquoi un test de SOURCE et pas de comportement ───────────────────────
 * Ce qu'on veut interdire est une FORME d'écriture, pas un résultat : « il ne
 * doit exister nulle part un appel qui passe un corps de requête à un
 * journal ». Un test de comportement ne couvrirait que les chemins qu'il
 * emprunte, et la onzième journalisation ajoutée demain lui échapperait.
 *
 * Test **pur** : il lit des fichiers, n'ouvre aucune connexion, ne démarre
 * aucun serveur.
 *
 * ── Comment il tombe ────────────────────────────────────────────────────────
 * Remettre `console.log("…", req.body)` sans `redactSensitive` : l'assertion
 * échoue en citant le fichier, la ligne et le texte exact.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.resolve(__dirname, "../../src");

/**
 * Expressions désignant un corps de requête ENTIER. `strictBody` et
 * `bodyWithSecurity` en font partie : tous deux dérivent du corps d'`/initiate`
 * et portent donc la même réponse de sécurité.
 *
 * ⚠️ LE `(?!\s*\.)` N'EST PAS UNE OPTIMISATION, C'EST LA RÈGLE B.4 ELLE-MÊME.
 *
 * La règle n'interdit pas de journaliser une donnée issue d'un corps : elle
 * impose d'en journaliser les **champs nommés** plutôt que le tout-venant.
 * `req.body.provider` est donc licite ; `req.body` ne l'est pas. Une première
 * version de ce test ne faisait pas la différence et signalait trois
 * journalisations parfaitement correctes de `validatePayment.js` et
 * `validateTransaction.js` — un test qui crie sur du code sain finit par être
 * désactivé, et emporte avec lui la protection qu'il apportait.
 */
/**
 * ══ ÉLARGI LE 2026-09-09 — LA GARDE AVAIT DEUX CÉCITÉS ═══════════════════════
 *
 * La version précédente valait :
 *
 *     /\b(req\.body|request\.body|bodyWithSecurity|strictBody|rawBody)\b(?!\s*\.)/
 *
 * Elle énumérait des NOMS DE VARIABLES. Deux écritures parfaitement banales lui
 * échappaient donc, et toutes deux existaient dans le code :
 *
 *   1. **Une variable simplement nommée `body`.** `transactionOrchestratorByFlow`
 *      en journalisait quatre — dont `resolveRouteContextForAction` (le corps
 *      d'un `confirm`, donc le CODE DE CONFIRMATION) et `dispatchToProvider`
 *      (le `strictBody`, donc la RÉPONSE À LA QUESTION DE SÉCURITÉ). Le test
 *      passait au vert sur exactement ce qu'il avait été écrit pour empêcher.
 *
 *   2. **Le chaînage optionnel.** `req\.body` porte un point LITTÉRAL :
 *      `req?.body` ne lui correspondait pas. `routeActionByFlow` écrivait
 *      `body: req?.body` en clair sur `/confirm` et `/cancel`.
 *
 * C'est le mode de défaillance que l'en-tête de ce fichier décrit déjà pour le
 * module de masquage — « une protection qu'on croit en place parce qu'on se
 * souvient de l'avoir écrite » — appliqué cette fois à la garde elle-même. La
 * leçon tient en une phrase : **un test de forme doit être aussi soigné que le
 * principe qu'il défend.**
 *
 * ── Ce que le nouveau motif dit, et ce qu'il continue d'autoriser ───────────
 *
 * Deux branches :
 *   · un identifiant NU (`body`, `strictBody`, `bodyWithSecurity`, `rawBody`)
 *     — le `(?<![.\w$])` empêche de confondre avec `out.body` ou `ctx.body`,
 *     qui sont traités par la seconde branche ou légitimes ;
 *   · `req.body` / `req?.body` / `request.body` / `request?.body`.
 *
 * Le `(?!\s*\.)` final est CONSERVÉ, et c'est toujours la règle B.4 elle-même :
 * journaliser `req.body.provider` — un champ NOMMÉ — reste licite ; c'est le
 * tout-venant qui ne l'est pas. Vérifié après élargissement : les
 * journalisations légitimes de `validatePayment.js` et `validateTransaction.js`
 * ne sont toujours pas signalées.
 */
const CORPS =
  /(?:(?<![.\w$])(?:body|strictBody|bodyWithSecurity|rawBody)\b|\b(?:req|request)\??\.body\b)(?!\s*\.)/;

/** Fonctions qui écrivent dans un journal. */
const JOURNAL = /\b(console\.(log|info|warn|error|debug)|logger\.(info|warn|error|debug)|log\.(info|warn|error|debug))\s*\(/;

/** Le seul emballage qui rend une journalisation acceptable. */
const MASQUE = /\bredactSensitive\s*\(/;

function fichiersJs(dossier) {
  const trouves = [];

  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    const complet = path.join(dossier, entree.name);
    if (entree.isDirectory()) {
      if (entree.name === "node_modules") continue;
      trouves.push(...fichiersJs(complet));
    } else if (entree.name.endsWith(".js")) {
      trouves.push(complet);
    }
  }

  return trouves;
}

/**
 * Un appel de journalisation peut s'étaler sur plusieurs lignes. On regarde
 * donc la ligne du journal ET les cinq suivantes, tant que la parenthèse n'est
 * pas refermée — sinon un `console.log(\n  "x",\n  req.body\n)` passerait.
 */
function fenetreDAppel(lignes, debut) {
  let profondeur = 0;
  let texte = "";

  for (let i = debut; i < Math.min(lignes.length, debut + 6); i++) {
    const nue = lignes[i].trim();
    if (!nue.startsWith("*") && !nue.startsWith("//")) texte += lignes[i] + "\n";
    for (const c of lignes[i]) {
      if (c === "(") profondeur += 1;
      else if (c === ")") profondeur -= 1;
    }
    if (i > debut && profondeur <= 0) break;
  }

  return texte;
}

test("aucun corps de requête n'est journalisé sans redactSensitive", () => {
  const fautes = [];

  for (const fichier of fichiersJs(RACINE)) {
    // Le module de masquage cite lui-même les motifs qu'il combat.
    if (fichier.endsWith(path.join("utils", "redactSensitive.js"))) continue;

    const lignes = fs.readFileSync(fichier, "utf8").split("\n");

    for (let i = 0; i < lignes.length; i++) {
      // Les commentaires citent les motifs qu'ils combattent — c'est leur rôle.
      const nue = lignes[i].trim();
      if (nue.startsWith("*") || nue.startsWith("//") || nue.startsWith("/*")) continue;

      if (!JOURNAL.test(lignes[i])) continue;

      const appel = fenetreDAppel(lignes, i);
      if (!CORPS.test(appel)) continue;
      if (MASQUE.test(appel)) continue;

      fautes.push(
        `${path.relative(RACINE, fichier)}:${i + 1}  ${lignes[i].trim().slice(0, 110)}`
      );
    }
  }

  assert.deepEqual(
    fautes,
    [],
    "Un corps de requête est journalisé sans masquage. Le corps d'un `/initiate` " +
      "porte la réponse à la question de sécurité en clair, celui d'un `/confirm` " +
      "le code de confirmation (règle B.4). Envelopper dans `redactSensitive(...)` " +
      "de `src/utils/redactSensitive.js`.\n\n  " +
      fautes.join("\n  ")
  );
});

/**
 * Le test ci-dessus ne vaut que si le masquage fait vraiment son travail. Sans
 * ce second contrôle, remplacer `redactSensitive` par une fonction identité
 * garderait la suite au vert.
 */
test("redactSensitive masque effectivement la réponse de sécurité", () => {
  const { redactSensitive, REDACTED } = require("../../src/utils/redactSensitive");

  const corps = {
    amount: 100,
    securityAnswer: "le nom de mon chien",
    security_answer: "idem",
    nested: { otpCode: "123456", validationCode: "999" },
  };

  const masque = redactSensitive(corps);

  assert.equal(masque.amount, 100, "le masquage ne doit pas toucher aux champs anodins");
  assert.equal(masque.securityAnswer, REDACTED);
  assert.equal(masque.security_answer, REDACTED);
  assert.equal(masque.nested.otpCode, REDACTED);
  assert.equal(masque.nested.validationCode, REDACTED);

  assert.ok(
    !JSON.stringify(masque).includes("le nom de mon chien"),
    "la valeur sensible survit quelque part dans la sortie masquée"
  );
});
