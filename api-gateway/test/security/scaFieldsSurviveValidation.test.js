"use strict";

/**
 * SCA dynamic linking — the phone signs the money-critical fields of an
 * initiation (`api-paynoval/src/services/security/transactionSignature.js#SCA_FIELDS`)
 * and Tx-Core recomputes the digest on the body THIS gateway forwards, after
 * Joi validation (`stripUnknown`, `convert`). A field stripped or rewritten
 * here would refuse every signed payment in `SCA_INVALID`.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL = process.env.SERVICE_PAYNOVAL_URL || "http://tx-core.test";

const test = require("node:test");
const assert = require("node:assert/strict");

const validateTransaction = require("../../src/middlewares/validateTransaction");

const SCA_FIELDS = [
  "amount",
  "funds",
  "destination",
  "quoteId",
  "pricingId",
  "toEmail",
  "phoneNumber",
  "toCountry",
  "recipientInfo",
];

function run(body) {
  return new Promise((resolve, reject) => {
    const req = { body, headers: {}, socket: {}, user: { country: "Cameroun" } };
    const res = {
      status(code) {
        this.code = code;
        return this;
      },
      json(payload) {
        reject(new Error(`refused ${this.code}: ${JSON.stringify(payload)}`));
      },
    };
    Promise.resolve(validateTransaction("initiate")(req, res, () => resolve(req.body))).catch(reject);
  });
}

const signedPart = (body) =>
  Object.fromEntries(SCA_FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));

test("a PayNoval transfer keeps every signed field as sent", async () => {
  const sent = {
    funds: "paynoval",
    destination: "paynoval",
    amount: 1500.5,
    toEmail: "zoe@example.com",
    quoteId: "q_1",
    pricingId: "p_1",
    toCountry: "Cameroun",
    recipientInfo: { email: "zoe@example.com", name: "Zoé" },
    question: "Couleur ?",
    securityCode: "bleu",
    country: "Cameroun",
  };
  const forwarded = await run({ ...sent });
  assert.deepEqual(signedPart(forwarded), signedPart(sent));
});

test("a mobile money transfer keeps every signed field as sent", async () => {
  const sent = {
    funds: "paynoval",
    destination: "mobilemoney",
    amount: 2000,
    phoneNumber: "+237690000000",
    operator: "mtn",
    quoteId: "q_2",
    toCountry: "Cameroun",
    country: "Cameroun",
  };
  const forwarded = await run({ ...sent });
  assert.deepEqual(signedPart(forwarded), signedPart(sent));
});
