"use strict";

/**
 * Plafonds — la passerelle authentifie et relaie, rien de plus (2026-10-17).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");

test("GET /api/v1/limits requires the user's JWT and relays to Tx-Core", () => {
  const src = read("routes/limitsRoutes.js");
  assert.match(src, /router\.get\("\/", protect, relayerVers\("\/api\/v1\/limits"\)\)/);
  assert.doesNotMatch(src, /router\.(post|put|patch|delete)\(/, "the client only reads its limits");
});

test("every limit-policy route requires a staff role", () => {
  const src = read("routes/limitPoliciesRoutes.js");
  const routes = src.match(/router\.(get|post|put|patch|delete)\([^\n]+/g) || [];
  assert.equal(routes.length, 4);
  for (const line of routes) assert.match(line, /authMiddleware, requireRole\(LIMIT_STAFF\), relais/);
  assert.match(src, /LIMIT_STAFF = \["admin", "superadmin", "compliance"\]/);
});

test("both are mounted, and hold no figure of their own", () => {
  const app = read("src/app.js");
  assert.match(app, /app\.use\("\/api\/v1\/limits", limitsRoutes\)/);
  assert.match(app, /app\.use\("\/api\/v1\/limit-policies", limitPoliciesRoutes\)/);
  for (const rel of ["routes/limitsRoutes.js", "routes/limitPoliciesRoutes.js"]) {
    assert.doesNotMatch(read(rel), /mongoose|require\("\.\.\/models/);
  }
});
