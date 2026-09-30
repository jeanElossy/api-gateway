"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL = process.env.SERVICE_PAYNOVAL_URL || "http://localhost:1";

const { auditForwardHeaders } = require("../../src/services/transactions/phoneSecurity");

const req = (headers) => ({ headers, id: "r1" });

test("the payment signature crosses the gateway to Tx-Core", () => {
  const out = auditForwardHeaders(
    req({
      "x-paynoval-signature": "A".repeat(344),
      "x-paynoval-signature-ts": "1800000000000",
      "x-device-id": "64b000000000000000000001",
    })
  );
  assert.equal(out["x-paynoval-signature"], "A".repeat(344));
  assert.equal(out["x-paynoval-signature-ts"], "1800000000000");
  assert.equal(out["x-device-id"], "64b000000000000000000001");
});

test("malformed signature headers are not relayed", () => {
  const out = auditForwardHeaders(req({ "x-paynoval-signature": "not base64 !", "x-paynoval-signature-ts": "x" }));
  assert.equal(out["x-paynoval-signature"], undefined);
});
