"use strict";

/**
 * Global rate limit keyed per VERIFIED account, not per IP (2026-09-30).
 *
 * Carrier-grade NAT puts thousands of mobile subscribers behind one address:
 * an IP bucket refuses them together. A verified access token gets its own
 * bucket; a forged or expired one is anonymous (IP bucket). A high per-IP
 * ceiling still stops a single machine's flood.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jwt = require("jsonwebtoken");

/* Posées AVANT le require : `src/config` valide au chargement. */
process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL = process.env.SERVICE_PAYNOVAL_URL || "http://localhost:1";
const SECRET = process.env.JWT_SECRET;

const { verifiedUserId } = require("../../src/utils/accessToken");

const reqWith = (token, ip = "41.202.0.1") => ({
  headers: token ? { authorization: `Bearer ${token}`, "x-forwarded-for": ip } : { "x-forwarded-for": ip },
});

test("a verified token yields the account id", () => {
  const token = jwt.sign({ id: "u-1" }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
  assert.equal(verifiedUserId(reqWith(token)), "u-1");
});

test("a forged token is anonymous (never its claimed sub)", () => {
  const forged = jwt.sign({ id: "victim" }, "attacker-secret", { algorithm: "HS256" });
  assert.equal(verifiedUserId(reqWith(forged)), null);
});

test("an expired token is anonymous", () => {
  const expired = jwt.sign({ id: "u-1", exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, { algorithm: "HS256" });
  assert.equal(verifiedUserId(reqWith(expired)), null);
});

test("no token is anonymous", () => {
  assert.equal(verifiedUserId(reqWith(null)), null);
});

test("the global limiter keys on the account, and an IP ceiling runs first", () => {
  const limiter = fs.readFileSync(path.join(__dirname, "..", "..", "src", "middlewares", "rateLimit.js"), "utf8");
  assert.match(limiter, /keyGenerator:\s*rateLimitSubject/);
  assert.match(limiter, /`acct:\$\{userId\}`/);
  assert.doesNotMatch(limiter, /name:\s*"gw-global-ip",[\s\S]{0,300}keyGenerator:\s*\(req\)\s*=>\s*`ip:/);

  const app = fs.readFileSync(path.join(__dirname, "..", "..", "src", "app.js"), "utf8");
  assert.match(app, /ipCeilingLimiter\(req, res, \(err\) =>[\s\S]{0,120}globalIpLimiter\(req, res, next\)/);
});
