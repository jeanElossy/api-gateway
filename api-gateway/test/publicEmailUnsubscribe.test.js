"use strict";

/**
 * Désinscription marketing (2026-10-20) : le lien de chaque e-mail et le POST
 * « un clic » de Gmail / Yahoo passent SANS signature — chemin exact, limite
 * dédiée, aucun identifiant relayé, montage AVANT la vérification de signature.
 * Avant ce correctif ils recevaient 401 (« public signature required »).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { isPublicEmailUnsubscribe, makePublicEmailUnsubscribe } = require("../src/middlewares/publicEmailUnsubscribe");

test("ouvert : GET (page), HEAD, POST (bouton et un clic RFC 8058)", () => {
  for (const m of ["GET", "HEAD", "POST", "post"]) assert.equal(isPublicEmailUnsubscribe(m, "/email/unsubscribe"), true);
});

test("rien d'autre : méthode, chemin voisin, traversée", () => {
  for (const [m, p] of [
    ["PUT", "/email/unsubscribe"],
    ["DELETE", "/email/unsubscribe"],
    ["GET", "/email"],
    ["GET", "/email/unsubscribe/x"],
    ["GET", "/email/../admin"],
    ["GET", "/cagnottes/by-code/CAG-1"],
  ]) {
    assert.equal(isPublicEmailUnsubscribe(m, p), false, `${m} ${p}`);
  }
});

function fake(method, p, headers = {}) {
  const req = { method, path: p, headers: { ...headers } };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  return { req, res };
}

test("relaye au backend sans aucun identifiant de l'appelant, sous limite", () => {
  const calls = [];
  const mw = makePublicEmailUnsubscribe({
    proxy: (req) => calls.push({ ...req.headers }),
    limiter: (req, res, next) => { calls.push("limited"); next(); },
    setCors() {},
  });
  const { req, res } = fake("POST", "/email/unsubscribe", { authorization: "Bearer x", cookie: "c", "x-internal-token": "t", "content-type": "application/x-www-form-urlencoded" });
  mw(req, res, () => assert.fail("ne doit pas continuer vers la signature"));
  assert.equal(calls[0], "limited");
  assert.deepEqual(Object.keys(calls[1]), ["content-type"]);
});

test("autre chemin : continue (vers la signature)", () => {
  let next = false;
  makePublicEmailUnsubscribe({ proxy() { assert.fail(); }, limiter() { assert.fail(); } })(fake("GET", "/fees").req, fake("GET", "/fees").res, () => { next = true; });
  assert.equal(next, true);
});

test("backend non configuré : 503 explicite, jamais un 401 trompeur", () => {
  const { req, res } = fake("GET", "/email/unsubscribe");
  makePublicEmailUnsubscribe({ proxy: null, limiter() {}, setCors() {} })(req, res, () => {});
  assert.equal(res.statusCode, 503);
});

test("⚠️ monté AVANT la vérification de signature de /api/v1/public", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const relay = src.indexOf("makePublicEmailUnsubscribe({");
  const signature = src.indexOf("return requirePublicSignature(req, res, next);");
  assert.ok(relay > 0 && signature > 0 && relay < signature);
});
