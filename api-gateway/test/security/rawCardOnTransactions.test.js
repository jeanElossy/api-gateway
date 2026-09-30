"use strict";

/**
 * A transaction body never carries a card number (2026-09-30).
 *
 * The mobile app used to send the full PAN of the selected card in
 * `/transactions/initiate` (as `cardNumber`, and copied into `accountNumber` /
 * `iban`): it crossed the gateway and Tx-Core, where it could end up in logs.
 * The app now sends `cardId` + last four digits; the edge refuses the rest.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  refuseRawCardDataOnTransactions,
} = require("../../src/middlewares/refuseRawCardData");

function run(body) {
  let status = null;
  let payload = null;
  let passed = false;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(p) {
      payload = p;
      return this;
    },
  };
  refuseRawCardDataOnTransactions({ body, headers: {} }, res, () => {
    passed = true;
  });
  return { status, payload, passed };
}

test("refuses a PAN, even nested", () => {
  const out = run({ amount: 10, recipientInfo: { cardNumber: "4111111111111111" } });
  assert.equal(out.passed, false);
  assert.equal(out.status, 400);
  assert.equal(out.payload.code, "RAW_CARD_DATA_REFUSED");
});

test("refuses a CVV", () => {
  assert.equal(run({ cvv: "123" }).passed, false);
});

test("lets a transfer with its security code and a saved card through", () => {
  const out = run({
    amount: 10,
    securityQuestion: "q",
    securityCode: "answer",
    cardId: "65f0",
    cardLast4: "4242",
    recipientInfo: { cardNumber: "" },
  });
  assert.equal(out.passed, true);
});

test("the guard is mounted on /initiate", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "routes", "transactions.js"), "utf8");
  assert.match(source, /"\/initiate",\s*\/\/[^\n]*\n\s*refuseRawCardDataOnTransactions,/);
});
