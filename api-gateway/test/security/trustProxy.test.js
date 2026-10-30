"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const proxyaddr = require("proxy-addr");

const { trustProxy, isCloudflare } = require("../../src/utils/trustProxy");

const clientIp = (forwardedFor) =>
  proxyaddr(
    { connection: { remoteAddress: "10.200.0.1" }, headers: { "x-forwarded-for": forwardedFor } },
    trustProxy
  );

test("le visiteur est trouvé derrière Cloudflare et le répartiteur Render", () => {
  assert.equal(clientIp("41.82.10.20, 104.22.72.4"), "41.82.10.20");
});

test("une adresse écrite par le client ne remplace jamais la vraie", () => {
  assert.equal(clientIp("9.9.9.9, 41.82.10.20, 104.22.72.4"), "41.82.10.20");
});

test("sans Cloudflare, le comportement reste celui d'un seul saut", () => {
  assert.equal(clientIp("9.9.9.9, 41.82.10.20"), "41.82.10.20");
});

test("IPv6 : même marche", () => {
  assert.equal(clientIp("2c0f:f0f8::1, 2606:4700:10::6816:4804"), "2c0f:f0f8::1");
});

test("isCloudflare ne reconnaît que les plages publiées", () => {
  assert.equal(isCloudflare("104.22.72.4"), true);
  assert.equal(isCloudflare("::ffff:104.22.72.4"), true);
  assert.equal(isCloudflare("41.82.10.20"), false);
  assert.equal(isCloudflare("pas une adresse"), false);
});

test("l'application utilise cette règle, plus un nombre de sauts", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "app.js"), "utf8");
  assert.match(source, /app\.set\("trust proxy", trustProxy\)/);
});

test("le corps est écrit APRÈS tous les en-têtes du relais principal", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "app.js"), "utf8");
  const start = source.indexOf("onProxyReq: (proxyReq, req, res) => {");
  const hook = source.slice(start, source.indexOf("onProxyRes:", start));
  const body = hook.indexOf("fixRequestBody(proxyReq, req)");
  assert.ok(body > -1);
  assert.ok(hook.lastIndexOf("proxyReq.setHeader(") < body);
  assert.ok(hook.indexOf("applyClientIpAttestation(proxyReq, req)") < body);
});
