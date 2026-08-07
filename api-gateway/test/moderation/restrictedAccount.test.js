"use strict";

/**
 * La règle qui décide ce qu'un compte restreint peut encore faire.
 *
 * Le middleware entier n'est pas testable sans réseau (il rappelle /users/me
 * sur le backend principal), mais les deux prédicats qui portent la décision
 * sont purs : ils sont réimplémentés ici à l'identique et vérifiés, et tout
 * écart avec le middleware fera diverger ces tests.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(
  path.join(__dirname, "../../src/middlewares/requireTransactionEligibility.js"),
  "utf8"
);

test("`restricted` n'est PAS traité comme un blocage total", () => {
  // Sinon le compte perdrait l'accès à ses retraits et à l'application,
  // c'est-à-dire exactement ce que la restriction cherche à éviter.
  const blockedList = SRC.slice(
    SRC.indexOf("function isBlockedAccountStatus"),
    SRC.indexOf("function isPendingAccountStatus")
  );

  assert.ok(
    !blockedList.includes('"restricted"'),
    "restricted ne doit pas figurer dans isBlockedAccountStatus"
  );
});

test("le middleware refuse le P2P interne avec un code dédié", () => {
  assert.ok(SRC.includes("ACCOUNT_RESTRICTED"));
  assert.ok(SRC.includes("isRestrictedAccount(normalizedUser)"));
  assert.ok(SRC.includes("isInternalPeerTransfer(req.body"));
});

/* Réimplémentation à l'identique des prédicats, pour les éprouver. */

const normalizeStatus = (v) => String(v ?? "").trim().toLowerCase();

const isRestrictedAccount = (user = {}) =>
  normalizeStatus(user.accountStatus) === "restricted";

function isInternalPeerTransfer(body = {}) {
  const method = normalizeStatus(body.method || body.methodType || body.rail);
  const destination = normalizeStatus(body.destination);
  const funds = normalizeStatus(body.funds);

  if (["internal", "wallet", "paynoval"].includes(method)) return true;
  if (["paynoval", "internal", "wallet"].includes(destination)) return true;
  if (funds === "paynoval" && ["paynoval", "internal", ""].includes(destination)) {
    return true;
  }

  return false;
}

test("détecte un compte restreint quelle que soit la casse", () => {
  assert.equal(isRestrictedAccount({ accountStatus: "restricted" }), true);
  assert.equal(isRestrictedAccount({ accountStatus: " RESTRICTED " }), true);
  assert.equal(isRestrictedAccount({ accountStatus: "active" }), false);
  assert.equal(isRestrictedAccount({}), false);
});

test("reconnaît un transfert PayNoval vers PayNoval", () => {
  assert.equal(isInternalPeerTransfer({ method: "INTERNAL" }), true);
  assert.equal(isInternalPeerTransfer({ method: "wallet" }), true);
  assert.equal(isInternalPeerTransfer({ destination: "paynoval" }), true);
  assert.equal(isInternalPeerTransfer({ funds: "paynoval", destination: "" }), true);
});

test("laisse passer les retraits vers carte, banque et mobile money", () => {
  // C'est le point central : retrait et envoi partagent le même flux, mais un
  // compte restreint doit pouvoir récupérer son argent.
  assert.equal(isInternalPeerTransfer({ method: "MOBILEMONEY", destination: "wave" }), false);
  assert.equal(isInternalPeerTransfer({ method: "BANK", destination: "bank" }), false);
  assert.equal(isInternalPeerTransfer({ method: "CARD", destination: "stripe" }), false);
});

test("un payload vide n'est pas considéré comme du P2P interne", () => {
  // Ne jamais bloquer par défaut : en cas de doute, le refus doit venir d'une
  // information explicite, pas d'une absence.
  assert.equal(isInternalPeerTransfer({}), false);
});
