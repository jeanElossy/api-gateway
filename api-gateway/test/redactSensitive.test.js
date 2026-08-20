"use strict";

/**
 * Masquage des valeurs sensibles avant journalisation.
 *
 * Régression visée : le contrôleur des transactions journalisait `req.body`
 * intégralement, y compris via `console.error` — le seul niveau que le
 * garde-fou de production ne réduit pas au silence. La réponse à la question de
 * sécurité d'un virement partait donc en clair dans les journaux de production
 * à chaque échec d'initiation.
 *
 * Ce que ces tests verrouillent :
 *   — les champs sensibles sont masqués, quelle que soit leur profondeur ;
 *   — les champs de diagnostic (montant, devise, pays) survivent, sinon le
 *     masquage rendrait les journaux inutiles et serait contourné ;
 *   — l'original n'est jamais muté, sinon on masquerait la valeur AVANT de la
 *     transmettre au microservice, et le virement échouerait.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  redactSensitive,
  isSensitiveKey,
  REDACTED,
} = require("../src/utils/redactSensitive");

/** Corps réaliste d'un POST /api/v1/transactions/initiate. */
function initiateBody() {
  return {
    amount: 25000,
    country: "CI",
    senderCurrencySymbol: "CAD",
    localCurrencySymbol: "XOF",
    securityQuestion: "Le prénom de ma mère ?",
    securityAnswer: "Aminata",
    idempotencyKey: "vault-abc-123",
    recipientInfo: {
      name: "Jean Kouassi",
      email: "jean@example.com",
    },
    metadata: {
      provider: "wave",
      device: { pin: "4821", model: "Pixel 8" },
    },
  };
}

test("la réponse de sécurité est masquée dans un corps d'initiation", () => {
  const out = redactSensitive(initiateBody());

  assert.equal(out.securityAnswer, REDACTED);
  assert.equal(out.metadata.device.pin, REDACTED);
});

test("les champs de diagnostic survivent au masquage", () => {
  const out = redactSensitive(initiateBody());

  // Sans eux, le journal ne sert plus à rien et quelqu'un finira par
  // réintroduire le log brut.
  assert.equal(out.amount, 25000);
  assert.equal(out.country, "CI");
  assert.equal(out.localCurrencySymbol, "XOF");
  assert.equal(out.metadata.provider, "wave");
  assert.equal(out.recipientInfo.name, "Jean Kouassi");

  // La QUESTION n'est pas un secret — seule la réponse l'est.
  assert.equal(out.securityQuestion, "Le prénom de ma mère ?");

  // La clé d'idempotence est un identifiant de corrélation, pas un secret :
  // c'est même la valeur la plus utile pour retrouver un virement.
  assert.equal(out.idempotencyKey, "vault-abc-123");
});

test("le corps d'origine n'est jamais muté", () => {
  const body = initiateBody();
  const before = JSON.stringify(body);

  redactSensitive(body);

  // Si le masquage mutait, la valeur réelle n'atteindrait plus le microservice
  // et tout virement échouerait — un correctif de journal casserait le produit.
  assert.equal(JSON.stringify(body), before);
  assert.equal(body.securityAnswer, "Aminata");
});

test("le corps de confirmation masque code et réponse sous toutes leurs formes", () => {
  const out = redactSensitive({
    transactionId: "665f1c2a4b1d3e0012a4b5c6",
    securityCode: "739104",
    security_answer: "Aminata",
    "SECURITY-ANSWER": "Aminata",
    validationCode: "739104",
    provider: "paynoval",
  });

  assert.equal(out.securityCode, REDACTED);
  assert.equal(out.security_answer, REDACTED);
  assert.equal(out["SECURITY-ANSWER"], REDACTED);
  assert.equal(out.validationCode, REDACTED);

  // L'identifiant de transaction reste : c'est la clé de toute investigation.
  assert.equal(out.transactionId, "665f1c2a4b1d3e0012a4b5c6");
  assert.equal(out.provider, "paynoval");
});

test("les variantes de nommage sont reconnues", () => {
  for (const key of [
    "securityAnswer",
    "security_answer",
    "SECURITY ANSWER",
    "pinCode",
    "pin_code",
    "refreshToken",
    "twoFaCode",
    "apiKey",
    "Authorization",
  ]) {
    assert.equal(isSensitiveKey(key), true, `${key} devrait être sensible`);
  }

  for (const key of ["amount", "currency", "transactionId", "securityQuestion"]) {
    assert.equal(isSensitiveKey(key), false, `${key} ne devrait pas être masqué`);
  }
});

test("les valeurs vides restent distinguables d'une valeur masquée", () => {
  const out = redactSensitive({
    securityAnswer: "",
    securityCode: null,
    pin: undefined,
    token: "abc",
  });

  // « Absent » et « masqué » sont deux diagnostics différents : un champ vide
  // explique un 400, un champ masqué non.
  assert.equal(out.securityAnswer, "");
  assert.equal(out.securityCode, null);
  assert.equal(out.pin, undefined);
  assert.equal(out.token, REDACTED);
});

test("les tableaux et les structures imbriquées sont traversés", () => {
  const out = redactSensitive({
    batch: [
      { amount: 100, securityAnswer: "un" },
      { amount: 200, securityAnswer: "deux" },
    ],
  });

  assert.equal(out.batch[0].securityAnswer, REDACTED);
  assert.equal(out.batch[1].securityAnswer, REDACTED);
  assert.equal(out.batch[0].amount, 100);
});

test("une imbrication excessive est tronquée sans lever", () => {
  let deep = { securityAnswer: "cachee" };
  for (let i = 0; i < 40; i += 1) deep = { nested: deep };

  // Un payload hostile ne doit ni faire exploser la pile ni faire échouer la
  // requête : la journalisation est un effet de bord, jamais un point de panne.
  assert.doesNotThrow(() => redactSensitive(deep));
});

test("les valeurs non-objets traversent sans transformation", () => {
  assert.equal(redactSensitive(null), null);
  assert.equal(redactSensitive(undefined), undefined);
  assert.equal(redactSensitive("texte"), "texte");
  assert.equal(redactSensitive(42), 42);
});
