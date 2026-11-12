"use strict";

/**
 * Les champs qui DÉFINISSENT un prix traversent la passerelle intacts.
 *
 * Tx-Core compare chaque initiation au devis figé, champ par champ
 * (`api-paynoval/src/services/pricing/quoteConsumption.js`, `CHAMPS_ENGAGEANTS`) :
 * un champ que la validation Joi retire (`stripUnknown`) ou réécrit ici rend
 * le devis inutilisable — `409 QUOTE_MISMATCH` pour une demande pourtant
 * conforme au départ du téléphone.
 *
 * Défaut mesuré le 2026-11-12 : le schéma `visa_direct` ne déclarait pas
 * `operator` ; tous les dépôts et retraits par carte étaient refusés. Ce test
 * échoue si un rail perd à nouveau l'un de ces champs.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL = process.env.SERVICE_PAYNOVAL_URL || "http://tx-core.test";

const test = require("node:test");
const assert = require("node:assert/strict");

const validateTransaction = require("../../src/middlewares/validateTransaction");

/**
 * `CHAMPS_ENGAGEANTS` (Tx-Core) que l'initiation LIT DANS LE CORPS sous ce nom.
 * `fromCurrency` / `toCurrency` n'y sont pas : Tx-Core les prend du corridor
 * verrouillé du compte (`corridorLock.lockedSourceCurrency`), jamais du corps.
 */
const PRICE_FIELDS = [
  "txType",
  "method",
  "amount",
  "country",
  "fromCountry",
  "toCountry",
  "provider",
  "operator",
];

function run(body) {
  return new Promise((resolve, reject) => {
    const req = { body, headers: {}, socket: {}, user: { country: "Canada" } };
    const res = {
      status(code) {
        this.code = code;
        return this;
      },
      json(payload) {
        resolve({ refused: this.code, payload });
      },
    };
    Promise.resolve(validateTransaction("initiate")(req, res, () => resolve({ forwarded: req.body }))).catch(reject);
  });
}

const priced = (body) => Object.fromEntries(PRICE_FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));

/** Le corps que le téléphone envoie pour un dépôt / retrait par carte (`moneyMovement.buildMoveInitiation`). */
const cardMove = (kind) => ({
  transactionType: kind,
  txType: kind === "deposit" ? "DEPOSIT" : "WITHDRAW",
  action: kind,
  methodType: "visa",
  method: "VISA",
  provider: "visa_direct",
  funds: kind === "deposit" ? "visa_direct" : "paynoval",
  destination: kind === "deposit" ? "paynoval" : "visa_direct",
  operator: "visa",
  amount: 150,
  currency: "CAD",
  fromCurrency: "CAD",
  toCurrency: "CAD",
  country: "CA",
  fromCountry: "CA",
  toCountry: "CA",
  cardId: "card_123",
  cardLast4: "4242",
  quoteId: "q_card",
});

for (const kind of ["deposit", "withdraw"]) {
  test(`carte (${kind}) : chaque champ du prix arrive à Tx-Core tel qu'envoyé, opérateur compris`, async () => {
    const sent = cardMove(kind);
    const { forwarded, refused, payload } = await run({ ...sent });
    assert.equal(refused, undefined, `refusé ${refused} : ${JSON.stringify(payload)}`);
    assert.deepEqual(priced(forwarded), priced(sent));
    assert.equal(forwarded.operator, "visa");
  });
}

test("mobile money : chaque champ du prix arrive tel qu'envoyé", async () => {
  const sent = {
    txType: "WITHDRAW",
    method: "MOBILE_MONEY",
    provider: "wave",
    funds: "paynoval",
    destination: "mobilemoney",
    operator: "wave",
    phoneNumber: "+2250700000000",
    amount: 5000,
    fromCurrency: "XOF",
    toCurrency: "XOF",
    country: "CI",
    fromCountry: "CI",
    toCountry: "CI",
    quoteId: "q_mm",
  };
  const { forwarded, refused, payload } = await run({ ...sent });
  assert.equal(refused, undefined, `refusé ${refused} : ${JSON.stringify(payload)}`);
  assert.deepEqual(priced(forwarded), priced(sent));
});

test("carte : un opérateur inconnu est REFUSÉ au bord, jamais effacé en silence", async () => {
  const { refused } = await run({ ...cardMove("deposit"), operator: "unknown-network" });
  assert.equal(refused, 400);
});

test("carte : une demande sans opérateur reste acceptée (rien n'est inventé)", async () => {
  const sent = cardMove("deposit");
  delete sent.operator;
  const { forwarded, refused } = await run({ ...sent });
  assert.equal(refused, undefined);
  assert.equal(forwarded.operator, undefined);
});
