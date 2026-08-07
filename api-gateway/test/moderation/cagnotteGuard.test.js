"use strict";

/**
 * Le garde des cagnottes doit bloquer ce qui envoie de l'argent, et RIEN
 * d'autre. Un garde trop large piégerait les fonds d'un compte restreint — il
 * ne pourrait plus liquider sa propre cagnotte — ou intercepterait un webhook
 * de provider.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const requireNotRestricted = require("../../src/middlewares/requireNotRestricted");

/** Les chemins réellement montés dans src/app.js. */
const PATHS = [/^\/$/, /^\/[^/]+\/join$/, /^\/[^/]+\/participations\/paynoval$/];

/**
 * ⚠️ `user` est passé en entier plutôt qu'un `accountStatus` avec valeur par
 * défaut : passer `accountStatus: undefined` déclencherait la valeur par
 * défaut du paramètre, et le cas « état absent » ne serait jamais testé.
 */
function run({ method = "POST", path = "/", user = { accountStatus: "restricted" } }) {
  const guard = requireNotRestricted({ methods: ["POST"], paths: PATHS });

  const req = { method, path, user };

  let refused = null;
  let passed = false;

  const res = {
    status(code) {
      refused = { code, body: null };
      return {
        json(body) {
          refused.body = body;
          return body;
        },
      };
    },
  };

  guard(req, res, () => {
    passed = true;
  });

  return { refused, passed };
}

test("bloque la création d'une cagnotte", () => {
  const { refused, passed } = run({ path: "/" });
  assert.equal(passed, false);
  assert.equal(refused.code, 403);
  assert.equal(refused.body.code, "ACCOUNT_RESTRICTED");
});

test("bloque la participation avec montant", () => {
  const { passed } = run({ path: "/64f0aa/join" });
  assert.equal(passed, false);
});

test("bloque la participation sur solde PayNoval", () => {
  const { passed } = run({ path: "/64f0aa/participations/paynoval" });
  assert.equal(passed, false);
});

test("laisse clôturer sa propre cagnotte", () => {
  // Bloquer ici piégerait les fonds : un compte restreint doit pouvoir liquider.
  const { passed } = run({ path: "/64f0aa/close" });
  assert.equal(passed, true);
});

test("laisse s'abonner : aucun argent en jeu", () => {
  const { passed } = run({ path: "/64f0aa/subscribe" });
  assert.equal(passed, true);
});

test("laisse passer le webhook provider", () => {
  // Authentifié par token gateway, sans req.user : il ne doit jamais dépendre
  // de l'état d'un compte client.
  const { passed } = run({ path: "/64f0aa/external-payment-callback" });
  assert.equal(passed, true);
});

test("ne touche pas aux lectures", () => {
  const { passed } = run({ method: "GET", path: "/" });
  assert.equal(passed, true);
});

test("laisse passer un compte actif sur les chemins bloqués", () => {
  for (const path of ["/", "/64f0aa/join", "/64f0aa/participations/paynoval"]) {
    const { passed } = run({ path, user: { accountStatus: "active" } });
    assert.equal(passed, true, `actif refusé sur ${path}`);
  }
});

test("fail-open quand l'état du compte est absent", () => {
  // Le backend principal refait le contrôle et fait autorité : bloquer sur une
  // donnée manquante couperait des parcours légitimes pour une raison technique.
  const { passed } = run({ path: "/", user: {} });
  assert.equal(passed, true);
});
