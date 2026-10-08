"use strict";

/**
 * AU BORD DU RÉSEAU : IP NON FALSIFIABLE, FREINAGE PAR COMPTE, AUCUNE DONNÉE
 * PERSONNELLE EN CLAIR (2026-10-08)
 *
 * Constats corrigés :
 *  · les limiteurs prenaient pour clé `cf-connecting-ip` / l'entrée gauche de
 *    `X-Forwarded-For` / `x-real-ip` — écrits par le client : un en-tête neuf,
 *    un compteur neuf, la limite de connexion ne protégeait plus rien ;
 *  · la connexion n'était freinée que par (IP, compte) : une attaque répartie
 *    contre UN compte ne l'était jamais ;
 *  · l'e-mail de connexion finissait en clair dans les clés Redis et les journaux.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

/* Posées AVANT le require : `src/config` valide au chargement. */
process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL = process.env.SERVICE_PAYNOVAL_URL || "http://localhost:1";

const { getClientIp, rateLimitIpKey } = require("../../src/utils/clientIp");
const { loginIdentifierDigest } = require("../../src/middlewares/rateLimit");

const ROOT = path.resolve(__dirname, "..", "..");

test("les en-têtes d'adresse écrits par le client sont IGNORÉS", () => {
  const req = {
    ip: "41.202.1.2",
    headers: { "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7", "cf-connecting-ip": "8.8.8.8" },
  };
  assert.equal(getClientIp(req), "41.202.1.2");
  assert.equal(rateLimitIpKey(req), "41.202.1.2");
});

test("changer l'en-tête ne change PAS le compteur", () => {
  const a = rateLimitIpKey({ ip: "41.202.1.2", headers: { "x-forwarded-for": "1.1.1.1" } });
  const b = rateLimitIpKey({ ip: "41.202.1.2", headers: { "x-forwarded-for": "2.2.2.2" } });
  assert.equal(a, b);
});

test("IPv6 regroupé en /64", () => {
  assert.equal(rateLimitIpKey({ ip: "2001:db8:1:2:aaaa::1" }), "2001:0db8:0001:0002::/64");
  assert.equal(rateLimitIpKey({ ip: "2001:db8:1:2:ffff:1:2:3" }), "2001:0db8:0001:0002::/64");
});

test("aucun fichier ne relit un en-tête d'adresse brut", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".js")) {
        fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n").forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (/headers\s*(\?\.)?\s*\[\s*["'](x-forwarded-for|x-real-ip|cf-connecting-ip)["']/i.test(line)) {
            offenders.push(`${rel}:${i + 1}`);
          }
        });
      }
    }
  };
  for (const d of ["src", "routes", "controllers"]) walk(d);
  assert.deepEqual(offenders, []);
});

test("l'identifiant de connexion n'apparaît qu'en empreinte", () => {
  const d1 = loginIdentifierDigest({ body: { emailOrPhone: "Awa@Example.com " } });
  const d2 = loginIdentifierDigest({ body: { email: "awa@example.com" } });
  assert.match(d1, /^[a-f0-9]{32}$/);
  assert.equal(d1, d2, "même compte, même empreinte (casse et espaces ignorés)");
  assert.equal(loginIdentifierDigest({ body: {} }), null);

  const src = fs.readFileSync(path.join(ROOT, "src", "middlewares", "rateLimit.js"), "utf8");
  assert.doesNotMatch(src, /identifier:\s*readLoginIdentifier/);
  assert.match(src, /const id = loginIdentifierDigest\(req\) \|\| "unknown";/);
});

test("la connexion est freinée PAR COMPTE, en plus de (IP, compte)", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "middlewares", "rateLimit.js"), "utf8");
  const block = src.slice(src.indexOf("const authAccountLimiter"), src.indexOf("const authAccountLimiter") + 1400);
  assert.match(block, /keyGenerator:\s*\(req\)\s*=>\s*`login-acct:\$\{loginIdentifierDigest\(req\)\}`/);
  assert.match(block, /skipSuccessfulRequests:\s*true/);
  const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  assert.match(app, /app\.use\("\/api\/v1\/auth\/login", authLoginLimiter, authAccountLimiter\)/);
});

test("console masquée au démarrage ; e-mail retiré du journal d'éligibilité", () => {
  assert.match(fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8"), /installConsoleRedaction\(\)/);
  const elig = fs.readFileSync(path.join(ROOT, "src", "middlewares", "requireTransactionEligibility.js"), "utf8");
  assert.doesNotMatch(elig, /email:\s*normalizedUser\.email/);
});
