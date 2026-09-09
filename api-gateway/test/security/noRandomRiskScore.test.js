"use strict";

/**
 * AUCUN SCORE DE RISQUE NE PEUT ÊTRE ALÉATOIRE
 * -----------------------------------------------------------------------------
 * `getMLScore` renvoyait `Math.random() * 0.4`. Le même retrait avait été fait
 * dans Tx Core et **n'avait jamais été reporté ici** : les deux `aml.js` ont
 * divergé, chacun recevant la moitié des correctifs.
 *
 * Ce garde-fou existe parce que le défaut est INVISIBLE à l'exécution — le
 * middleware répondait correctement, les tests passaient, et personne ne pouvait
 * remarquer qu'un contrôle de conformité ne contrôlait rien.
 *
 * ⚠️ CE QU'IL VÉRIFIE VRAIMENT : qu'aucun hasard et aucune horloge n'entre dans
 * le calcul d'un score. Un score de risque doit être REPRODUCTIBLE — lors d'un
 * litige ou d'un contrôle, il faut pouvoir réexpliquer pourquoi une transaction
 * a été notée comme elle l'a été. `Math.random()` et `Date.now()` rendent cela
 * impossible.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..", "..");

const lire = (rel) => fs.readFileSync(path.join(RACINE, rel), "utf8");

/** Retire commentaires de bloc et de ligne : on n'audite que du code vivant. */
const sansCommentaires = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FICHIERS_AML = ["src/services/aml.js", "src/middlewares/aml.js"];

/**
 * ⚠️ TOUT `Math.random` N'EST PAS UN DÉFAUT, et un garde qui les interdit tous
 * se fait désactiver au premier faux positif.
 *
 * `middlewares/aml.js:1106` en contient un LÉGITIME : il tire au sort LAQUELLE
 * des questions de sécurité de l'utilisateur sera posée. L'imprévisibilité y
 * est la propriété recherchée, l'exact inverse d'un score.
 *
 * Ce garde épingle donc l'usage connu par son contexte, et fait échouer TOUT
 * ajout. Un nouveau `Math.random` dans un fichier AML devra être justifié ici,
 * explicitement, pour passer.
 */
const USAGES_LEGITIMES = Object.freeze({
  "src/middlewares/aml.js": [
    {
      motif: /const qIdx = Math\.floor\(Math\.random\(\) \* userQuestions\.length\);/,
      raison:
        "choix de la question de sécurité à poser — l'imprévisibilité est la " +
        "propriété voulue, ce n'est pas une notation",
    },
  ],
  "src/services/aml.js": [],
});

for (const rel of FICHIERS_AML) {
  test(`${rel} — aucun \`Math.random\` qui ne soit explicitement justifié`, () => {
    const src = sansCommentaires(lire(rel));

    let restant = src;

    for (const { motif } of USAGES_LEGITIMES[rel]) {
      assert.match(
        restant,
        motif,
        `L'usage légitime attendu a disparu de ${rel} — la liste ci-dessus est ` +
          `périmée, la relire avant de la corriger.`
      );
      restant = restant.replace(motif, "");
    }

    const orphelins = restant.match(/Math\.random\s*\(/g) || [];

    assert.deepEqual(
      orphelins,
      [],
      `${rel} contient ${orphelins.length} \`Math.random()\` non justifié(s). ` +
        `Si c'est un score de risque : un tirage au sort n'est pas une ` +
        `approximation en attendant mieux, il occupe la place du vrai contrôle ` +
        `et rend le score d'une transaction passée irreproductible — ni ` +
        `explicable au client, ni justifiable devant un régulateur. Si c'est un ` +
        `usage légitime, l'ajouter à USAGES_LEGITIMES avec sa raison.`
    );
  });

  test(`${rel} — \`getMLScore\` n'est pas réintroduit`, () => {
    const src = sansCommentaires(lire(rel));

    assert.ok(
      !/getMLScore/.test(src),
      `${rel} réintroduit \`getMLScore\`. Le moteur de risque qui fait autorité ` +
        `est \`api-paynoval/src/services/risk/riskScore.js\` — déterministe, à ` +
        `trois bandes, chaque point de score nommant son motif. L'invariant 12 ` +
        `place Tx Core au centre : la passerelle ne refait pas sa propre notation.`
    );
  });
}

/**
 * Le plafond par transaction, LUI, doit rester — c'était le seul contrôle réel
 * que le bloc supprimé prétendait porter, et il est appliqué ailleurs, plus
 * haut, de façon déterministe. Sans cette assertion, quelqu'un pourrait retirer
 * le vrai plafond en croyant nettoyer le reste du faux score.
 */
test("le plafond par transaction survit au retrait du faux score", () => {
  const src = sansCommentaires(lire("src/middlewares/aml.js"));

  assert.match(src, /AML_SINGLE_LIMIT/);
  assert.match(src, /amount\s*>\s*singleTxLimit/);
});

/**
 * ⚠️ CE TEST VISE L'AUTRE MOITIÉ DE LA DIVERGENCE.
 *
 * Tx Core porte le commentaire qui interdit la réintroduction. Si quelqu'un le
 * supprimait, la raison du retrait disparaîtrait des deux dépôts à la fois et
 * la fonction reviendrait au prochain « nettoyage ».
 */
test("Tx Core conserve la trace du retrait — c'est elle qui porte la raison", () => {
  const rel = "../../api-paynoval/src/services/aml.js";
  const chemin = path.join(RACINE, rel);

  if (!fs.existsSync(chemin)) {
    // Le dépôt peut être absent d'un checkout isolé : on ne fait pas échouer
    // la suite de la passerelle pour ça, mais on ne prétend pas avoir vérifié.
    return;
  }

  const src = fs.readFileSync(chemin, "utf8");

  assert.match(src, /getMLScore` A ÉTÉ RETIRÉ/);
  assert.ok(
    !/Math\.random\s*\(/.test(sansCommentaires(src)),
    "Tx Core a réintroduit un tirage aléatoire sur le chemin AML."
  );
});
