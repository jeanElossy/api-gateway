"use strict";

/**
 * The initiation contract the mobile app sends (`payNoval-master/utils/wireContract.js`),
 * validated at the edge — defect of 2026-10-08:
 *   - the card schema demanded `cardNumber` + `cvc`, which the edge refuses
 *     one middleware earlier: no card operation could ever pass;
 *   - the outbound schemas did not declare the security question, and
 *     `stripUnknown` removed it: Tx-Core then refused a third-party transfer
 *     with « securityQuestion + securityAnswer requis ».
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL = process.env.SERVICE_PAYNOVAL_URL || "http://tx-core.test";

const test = require("node:test");
const assert = require("node:assert/strict");

const validateTransaction = require("../../src/middlewares/validateTransaction");

function run(body) {
  return new Promise((resolve) => {
    const req = { body, headers: {}, socket: {}, user: { country: "Côte d'Ivoire" } };
    const res = {
      status(code) {
        this.code = code;
        return this;
      },
      json(payload) {
        resolve({ refused: true, code: this.code, payload });
      },
    };
    validateTransaction("initiate")(req, res, () => resolve({ refused: false, body: req.body }));
  });
}

test("a third-party mobile money transfer keeps its security question", async () => {
  const out = await run({
    funds: "paynoval",
    destination: "mobilemoney",
    action: "send",
    amount: 5000,
    phoneNumber: "+2250700000001",
    operator: "wave",
    country: "CI",
    question: "Ville ?",
    securityCode: "Abidjan",
  });

  assert.equal(out.refused, false, JSON.stringify(out.payload));
  assert.equal(out.body.question, "Ville ?");
  assert.equal(out.body.securityCode, "Abidjan");
});

test("a withdrawal to one's own number needs no question", async () => {
  const out = await run({
    funds: "paynoval",
    destination: "mobilemoney",
    action: "withdraw",
    amount: 5000,
    phoneNumber: "+2250700000001",
    operator: "orange",
    country: "CI",
  });

  assert.equal(out.refused, false, JSON.stringify(out.payload));
});

test("a card operation passes with the SAVED card reference only", async () => {
  const out = await run({
    funds: "visa_direct",
    destination: "paynoval",
    action: "deposit",
    amount: 10000,
    cardId: "card_123",
    cardLast4: "4242",
    country: "CI",
  });

  assert.equal(out.refused, false, JSON.stringify(out.payload));
  assert.equal(out.body.cardId, "card_123");
});

test("a card operation without a saved card reference is refused", async () => {
  const out = await run({
    funds: "paynoval",
    destination: "visa_direct",
    action: "withdraw",
    amount: 10000,
    country: "CI",
  });

  assert.equal(out.refused, true);
  assert.equal(out.code, 400);
});

test("the spellings the app used to send are still refused (contract, not tolerance)", async () => {
  const out = await run({
    funds: "paynoval",
    destination: "mobile_money",
    amount: 5000,
    phoneNumber: "+2250700000001",
    operator: "Wave",
    country: "CI",
  });

  assert.equal(out.refused, true);
});
