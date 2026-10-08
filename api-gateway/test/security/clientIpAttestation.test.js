"use strict";

/**
 * IP CLIENTE ATTESTÉE — la passerelle, bord du réseau, la signe pour le
 * principal (2026-10-07). Le vecteur est partagé avec
 * `paynoval-backend/tests/clientIp.test.js` : si l'un des deux algorithmes
 * dérive, l'un des deux tests tombe. Tests purs (+ lecture de source).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const att = require("../../src/utils/clientIpAttestation");

const KEY = att.deriveAttestationKey("test-secret-0123456789");
const VECTOR = {
  ip: "41.202.1.2",
  ts: "1700000000000",
  method: "post",
  path: "/api/v1/auth/login?x=1",
  sig: "1081a0524f8932a031f5bd6c5730f071ea9abf933fbd7256cd961ccfbe6c54e2",
};

test("le vecteur partagé avec le backend est reproduit", () => {
  assert.equal(att.signClientIp({ key: KEY, ...VECTOR }), VECTOR.sig);
});

test("les en-têtes posés lient l'IP, l'horodatage, la méthode et le chemin", () => {
  const h = att.buildAttestationHeaders({ key: KEY, ip: "::ffff:41.202.1.2", method: "GET", path: "/a", now: 1700000000000 });
  assert.equal(h["x-paynoval-client-ip"], "41.202.1.2");
  assert.equal(h["x-paynoval-client-ip-ts"], "1700000000000");
  assert.equal(
    h["x-paynoval-client-ip-sig"],
    att.signClientIp({ key: KEY, ip: "41.202.1.2", ts: "1700000000000", method: "GET", path: "/a" })
  );
});

test("sans clé ou sans IP exploitable : aucune attestation (jamais une valeur inventée)", () => {
  assert.equal(att.buildAttestationHeaders({ key: null, ip: "1.2.3.4", method: "GET", path: "/" }), null);
  assert.equal(att.buildAttestationHeaders({ key: KEY, ip: "", method: "GET", path: "/" }), null);
  assert.equal(att.buildAttestationHeaders({ key: KEY, ip: "1.2.3.4<script>", method: "GET", path: "/" }), null);
});

test("la clé est dérivée : le jeton interne ne voyage jamais", () => {
  assert.notDeepEqual(KEY, Buffer.from("test-secret-0123456789"));
});

test("le proxy retire les en-têtes du client AVANT de poser les siens, HTTP et WebSocket", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "app.js"), "utf8");
  const fn = src.slice(src.indexOf("function applyClientIpAttestation"), src.indexOf("function applyClientIpAttestation") + 1200);
  assert.ok(fn.indexOf("removeHeader") > -1 && fn.indexOf("removeHeader") < fn.indexOf("setHeader"));
  assert.equal((src.match(/^\s+applyClientIpAttestation\(proxyReq, req\);$/gm) || []).length, 2);
  assert.match(src, /deriveAttestationKey\(\s*config\.principalInternalToken\s*\)/);
});
