"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * TEST DE CHARGEMENT
 * =============================================================================
 *
 * Il ne vérifie pas un comportement : il vérifie que le module **se charge**.
 *
 * Un `const` déclaré au niveau module est en zone morte temporelle jusqu'à sa
 * ligne. Le lire au-dessus lève `ReferenceError: Cannot access 'x' before
 * initialization`, au chargement, avant que le serveur n'écoute — le service
 * ne démarre tout simplement plus. C'est ce qui a fait boucler un déploiement.
 *
 * ⚠️ `node --check` NE L'ATTRAPE PAS : il valide la syntaxe, pas l'ordre
 * d'évaluation. Seule une évaluation réelle le révèle.
 *
 * Ici c'est possible et c'est la meilleure garantie : `src/app.js` **construit**
 * l'application sans ouvrir de connexion ni écouter — c'est `src/server.js` qui
 * s'en charge. Le chargement est donc sûr dans une suite pure.
 *
 * Le chargement se fait dans un PROCESSUS SÉPARÉ : `app.js` installe des
 * intergiciels, des minuteries et des écouteurs de processus qu'on ne veut pas
 * voir survivre dans le processus de test — sans quoi la suite ne se
 * terminerait pas d'elle-même.
 */

const ROOT = path.join(__dirname, "..");

function loadInChildProcess(relative) {
  return execFileSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(path.join(ROOT, relative))}); process.exit(0);`],
    {
      cwd: ROOT,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        JWT_SECRET: process.env.JWT_SECRET || "t".repeat(48),
        SERVICE_PAYNOVAL_URL:
          process.env.SERVICE_PAYNOVAL_URL || "http://localhost:5001",
      },
    }
  ).toString();
}

test("src/app.js se charge sans ReferenceError", () => {
  // Le défaut visé : un bloc inséré au-dessus de la déclaration de `logger`
  // qui le référence. Le module lève au chargement, le service ne démarre plus.
  assert.doesNotThrow(
    () => loadInChildProcess("src/app.js"),
    "src/app.js ne se charge pas — voir la sortie du processus enfant"
  );
});

test("les modules de service se chargent isolément", () => {
  for (const rel of [
    "src/services/rateLimitStore.js",
    "src/services/readiness.js",
    "src/services/circuitBreaker.js",
    "src/services/resilientStore.js",
    "src/middlewares/rateLimiter.js",
  ]) {
    assert.doesNotThrow(() => loadInChildProcess(rel), rel);
  }
});
