"use strict";

/**
 * V1 — UN SEUL TYPE DE COMPTE : LE KYC VAUT POUR TOUS (2026-10-07)
 *
 * La passerelle exemptait du KYC tout profil « entreprise » au KYB validé. Les
 * comptes entreprise et le KYB sont retirés (retour en V2) : un profil hérité
 * portant encore ces marques est un particulier. Ce test ÉCHOUE si l'on
 * réintroduit l'exemption.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

/* Posées AVANT le require : `src/config` valide au chargement. */
process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL = process.env.SERVICE_PAYNOVAL_URL || "http://localhost:1";

const {
  buildEligibilityFailure,
  normalizeUserForTransactions,
} = require("../../src/middlewares/requireTransactionEligibility");

const LEGACY_BUSINESS = {
  _id: "64b000000000000000000001",
  emailVerified: true,
  phoneVerified: true,
  accountStatus: "active",
  userType: "entreprise",
  role: "business",
  isBusiness: true,
  kybStatus: "verified",
  businessStatus: "verified",
  businessKYBLevel: 3,
  kybVerified: true,
  kycStatus: "none",
};

const codes = (user) => buildEligibilityFailure(normalizeUserForTransactions(user)).map((f) => f.code);

test("un profil hérité « entreprise » au KYB validé doit passer le KYC", () => {
  const c = codes(LEGACY_BUSINESS);
  assert.ok(c.includes("KYC_REQUIRED"), c.join(","));
  assert.ok(!c.includes("KYB_REQUIRED"));
});

test("un compte au KYC validé passe — comportement inchangé pour le particulier", () => {
  assert.deepEqual(codes({ ...LEGACY_BUSINESS, userType: "individu", isBusiness: false, kycStatus: "verified" }), []);
});

test("le profil normalisé ne fabrique plus de drapeau entreprise", () => {
  const u = normalizeUserForTransactions({ ...LEGACY_BUSINESS, kycStatus: "verified", isBusiness: undefined, kybVerified: undefined });
  assert.equal(u.isBusiness, undefined);
  assert.equal(u.kybVerified, undefined);
});
