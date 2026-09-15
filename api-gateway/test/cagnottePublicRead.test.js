"use strict";

/**
 * Page de paiement invité — lecture publique d'une cagnotte SANS signature
 * (décision du 2026-09-15).
 *
 * Avant, tout `/api/v1/public/*` exigeait une signature HMAC impossible à
 * produire depuis un navigateur : la page `/pay/cagnotte/:code` ne pouvait
 * pas se charger. Ces tests verrouillent l'ouverture MINIMALE : deux lectures
 * exactes, une limite dédiée, aucun identifiant relayé — et le montage AVANT
 * la vérification de signature.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  isPublicCagnotteRead,
  makePublicCagnotteRead,
  publicCagnotteLimits,
} = require("../src/middlewares/publicCagnotteRead");

test("les deux lectures ouvertes : fiche et devis par code", () => {
  assert.equal(isPublicCagnotteRead("GET", "/cagnottes/by-code/CAG-7K3M9Q2X"), true);
  assert.equal(isPublicCagnotteRead("GET", "/cagnottes/by-code/CAG-7K3M9Q2X/quote"), true);
  assert.equal(isPublicCagnotteRead("HEAD", "/cagnottes/by-code/PN-ABC123"), true);
});

test("rien d'autre n'est ouvert : méthode, chemin voisin, traversée, encodage", () => {
  const closed = [
    ["POST", "/cagnottes/by-code/CAG-7K3M9Q2X"],
    ["PUT", "/cagnottes/by-code/CAG-7K3M9Q2X/quote"],
    ["DELETE", "/cagnottes/by-code/CAG-7K3M9Q2X"],
    ["GET", "/cagnottes"],
    ["GET", "/cagnottes/by-code/"],
    ["GET", "/cagnottes/by-code/CAG-7K3M9Q2X/participants"],
    ["GET", "/cagnottes/by-code/../../admin"],
    ["GET", "/cagnottes/by-code/CAG%2F..%2Fadmin"],
    ["GET", "/cagnottes/by-code/CAG.7K3M"],
    ["GET", "/cagnottes/64b000000000000000000001"],
    ["GET", "/fees/simulate"],
  ];

  for (const [method, p] of closed) {
    assert.equal(isPublicCagnotteRead(method, p), false, `${method} ${p} ne doit pas être ouvert`);
  }
});

function fakeReqRes(method, p, headers = {}) {
  const req = { method, path: p, headers: { ...headers } };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return { req, res };
}

test("une lecture ouverte passe par la limite PUIS par le proxy, sans identifiant de l'appelant", () => {
  const calls = [];
  const limiter = (req, res, done) => {
    calls.push("limiter");
    done();
  };
  const proxy = (req) => {
    calls.push("proxy");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers["x-internal-token"], undefined);
    assert.equal(req.headers.accept, "application/json");
  };

  const mw = makePublicCagnotteRead({ proxy, limiter, setCors: () => {} });
  const { req, res } = fakeReqRes("GET", "/cagnottes/by-code/CAG-7K3M9Q2X", {
    authorization: "Bearer volé",
    cookie: "sid=1",
    "x-internal-token": "x",
    accept: "application/json",
  });

  let nextCalled = false;
  mw(req, res, () => {
    nextCalled = true;
  });

  assert.deepEqual(calls, ["limiter", "proxy"]);
  assert.equal(nextCalled, false);
});

test("tout autre chemin continue vers la vérification de signature (next), sans proxy", () => {
  let proxied = false;
  const mw = makePublicCagnotteRead({
    proxy: () => {
      proxied = true;
    },
    limiter: (req, res, done) => done(),
    setCors: () => {},
  });

  const { req, res } = fakeReqRes("POST", "/cagnottes/by-code/CAG-7K3M9Q2X", { authorization: "Bearer x" });
  let nextCalled = false;
  mw(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(proxied, false);
  assert.equal(req.headers.authorization, "Bearer x", "hors lecture ouverte, on ne touche à rien");
});

test("backend principal non configuré : 503 explicite, jamais une réponse vide", () => {
  const mw = makePublicCagnotteRead({ proxy: null, limiter: () => assert.fail(), setCors: () => {} });
  const { req, res } = fakeReqRes("GET", "/cagnottes/by-code/CAG-7K3M9Q2X");
  mw(req, res, () => assert.fail("ne doit pas continuer"));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "PRINCIPAL_UNAVAILABLE");
});

test("limite dédiée : 30 lectures par minute par défaut, valeurs illisibles rejetées", () => {
  assert.deepEqual(publicCagnotteLimits(), { windowMs: 60000, max: 30 });
  assert.deepEqual(publicCagnotteLimits({ windowMs: "abc", max: 0 }), { windowMs: 60000, max: 30 });
  assert.deepEqual(publicCagnotteLimits({ windowMs: 120000, max: 10 }), { windowMs: 120000, max: 10 });
});

test("app.js monte la lecture ouverte AVANT la vérification de signature", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const mount = app.indexOf("makePublicCagnotteRead({");
  const signature = app.indexOf("return requirePublicSignature(req, res, next);");

  assert.ok(mount > 0, "le montage doit exister");
  assert.ok(signature > 0);
  assert.ok(mount < signature, "monté après la signature, il ne servirait jamais");
  assert.match(app, /name: "gw-public-cagnotte"/, "limite dédiée nommée (compartiment Redis distinct)");
});
