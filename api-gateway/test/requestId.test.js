"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  requestIdMiddleware,
  resolveRequestId,
  generateRequestId,
} = require("../src/utils/requestId");

function fakeRes() {
  const headers = {};

  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
  };
}

function runMiddleware(incomingHeaders = {}) {
  const req = { headers: { ...incomingHeaders } };
  const res = fakeRes();
  let called = false;

  requestIdMiddleware(req, res, () => {
    called = true;
  });

  return { req, res, called };
}

test("un identifiant est généré quand le client n'en fournit aucun", () => {
  const { req, res } = runMiddleware();

  assert.ok(req.id, "req.id doit être posé");
  assert.equal(req.requestIdSource, "generated");
  assert.equal(req.headers["x-request-id"], req.id);
  assert.equal(res.headers["X-Request-Id"], req.id);
});

test("un identifiant client valide est conservé — c'est ce qui permet de corréler bout en bout", () => {
  const id = "6f1c2b4a-9d3e-4f77-8a11-2c9e5d7b0a34";
  const { req } = runMiddleware({ "x-request-id": id });

  assert.equal(req.id, id);
  assert.equal(req.requestIdSource, "client");
});

test("un identifiant porteur d'un retour à la ligne est refusé", () => {
  // Accepté tel quel, il permettrait de forger de fausses lignes dans les
  // journaux des trois services.
  const { req } = runMiddleware({
    "x-request-id": "abc123def\n[ERROR] faux message injecte",
  });

  assert.equal(req.requestIdSource, "generated");
  assert.ok(!req.id.includes("\n"));
});

test("un identifiant démesuré est refusé", () => {
  const { req } = runMiddleware({ "x-request-id": "a".repeat(5000) });

  assert.equal(req.requestIdSource, "generated");
  assert.ok(req.id.length <= 128);
});

test("un identifiant trop court est refusé", () => {
  const { req } = runMiddleware({ "x-request-id": "abc" });
  assert.equal(req.requestIdSource, "generated");
});

test("un en-tête répété ne retient que la première valeur", () => {
  // Concaténer deux valeurs produirait une chaîne qui n'identifie rien.
  const { id, source } = resolveRequestId(["req-11111111", "req-22222222"]);

  assert.equal(id, "req-11111111");
  assert.equal(source, "client");
});

test("les caractères d'espacement autour de l'identifiant sont tolérés", () => {
  const { id, source } = resolveRequestId("  req-abcdef12  ");

  assert.equal(id, "req-abcdef12");
  assert.equal(source, "client");
});

test("les valeurs non exploitables retombent sur une génération", () => {
  for (const bad of [undefined, null, "", "   ", 42, {}, [], ["  "]]) {
    const { source } = resolveRequestId(bad);
    assert.equal(source, "generated", `${JSON.stringify(bad)} doit être refusé`);
  }
});

test("un identifiant contenant deux-points ou espace est refusé", () => {
  // Ces caractères cassent les journaux structurés en clé:valeur.
  for (const bad of ["req:12345678", "req 12345678", "req;12345678"]) {
    assert.equal(resolveRequestId(bad).source, "generated");
  }
});

test("les identifiants générés sont uniques", () => {
  const seen = new Set();

  for (let i = 0; i < 1000; i += 1) {
    seen.add(generateRequestId());
  }

  assert.equal(seen.size, 1000);
});

test("la chaîne suivante du middleware est toujours appelée", () => {
  assert.equal(runMiddleware().called, true);
  assert.equal(runMiddleware({ "x-request-id": "bad\nvalue" }).called, true);
});

test("un res incapable de poser un en-tête ne fait pas échouer la requête", () => {
  const req = { headers: {} };
  const res = {
    setHeader() {
      throw new Error("headers already sent");
    },
  };

  let called = false;
  assert.doesNotThrow(() => {
    requestIdMiddleware(req, res, () => {
      called = true;
    });
  });

  assert.equal(called, true);
  assert.ok(req.id);
});
