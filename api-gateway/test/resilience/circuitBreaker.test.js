"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCircuitBreaker,
  countsAsFailure,
  isClientFault,
} = require("../../src/services/circuitBreaker");

/**
 * L'horloge est injectée : toutes les transitions se vérifient en faisant
 * avancer un nombre. Aucun réseau, aucune attente réelle.
 */
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function make(opts = {}) {
  const clock = makeClock();
  const cb = createCircuitBreaker({ now: clock.now, ...opts });
  return { cb, clock };
}

const KEY = "https://tx-core.internal";

/* -------------------------------------------------------------------------- */
/* Ce qui compte comme un échec — le piège principal                          */
/* -------------------------------------------------------------------------- */

test("une 4xx n'incrimine PAS le fournisseur", () => {
  // Les compter ferait ouvrir le disjoncteur à cause des utilisateurs
  // eux-mêmes : quelques requêtes malformées, et un service sain est coupé
  // pour tout le monde.
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(countsAsFailure({ status }), false, `status ${status}`);
    assert.equal(isClientFault(status), true);
  }
});

test("429 est une exception : c'est le fournisseur qui refuse", () => {
  assert.equal(countsAsFailure({ status: 429 }), true);
  assert.equal(isClientFault(429), false);
});

test("les 5xx et les erreurs de transport comptent", () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(countsAsFailure({ status }), true, `status ${status}`);
  }

  assert.equal(countsAsFailure({ transportError: true }), true);
  assert.equal(countsAsFailure({}), true); // pas de réponse du tout
});

test("une rafale de 400 n'ouvre jamais le disjoncteur", () => {
  const { cb } = make({ failureThreshold: 3 });

  for (let i = 0; i < 50; i += 1) cb.onFailure(KEY, { status: 400 });

  assert.equal(cb.inspect(KEY).state, "closed");
  assert.equal(cb.canRequest(KEY).allowed, true);
});

/* -------------------------------------------------------------------------- */
/* Ouverture                                                                  */
/* -------------------------------------------------------------------------- */

test("un seul échec n'ouvre pas — un incident passager n'est pas une panne", () => {
  const { cb } = make({ failureThreshold: 5 });

  cb.onFailure(KEY, { status: 503 });

  assert.equal(cb.inspect(KEY).state, "closed");
  assert.equal(cb.inspect(KEY).failures, 1);
});

test("le seuil atteint ouvre le disjoncteur", () => {
  const { cb } = make({ failureThreshold: 3 });

  cb.onFailure(KEY, { status: 503 });
  cb.onFailure(KEY, { status: 503 });
  assert.equal(cb.inspect(KEY).state, "closed");

  cb.onFailure(KEY, { status: 503 });
  assert.equal(cb.inspect(KEY).state, "open");
});

test("ouvert, les appels sont refusés SANS toucher au réseau", () => {
  // Tout le gain est là : échouer en une microseconde plutôt qu'attendre le
  // délai d'expiration, et cesser de matraquer le service aval.
  const { cb } = make({ failureThreshold: 1, openMs: 30_000 });

  cb.onFailure(KEY, { transportError: true });

  const gate = cb.canRequest(KEY);
  assert.equal(gate.allowed, false);
  assert.equal(gate.state, "open");
  assert.ok(gate.retryAfterSec > 0 && gate.retryAfterSec <= 30);
});

test("un succès remet le compteur d'échecs à zéro", () => {
  const { cb } = make({ failureThreshold: 3 });

  cb.onFailure(KEY, { status: 503 });
  cb.onFailure(KEY, { status: 503 });
  cb.onSuccess(KEY);
  cb.onFailure(KEY, { status: 503 });

  assert.equal(cb.inspect(KEY).state, "closed");
});

test("une 4xx au milieu d'une série de 503 n'efface pas la série", () => {
  const { cb } = make({ failureThreshold: 3 });

  cb.onFailure(KEY, { status: 503 });
  cb.onFailure(KEY, { status: 400 });
  cb.onFailure(KEY, { status: 503 });
  cb.onFailure(KEY, { status: 503 });

  assert.equal(cb.inspect(KEY).state, "open");
});

/* -------------------------------------------------------------------------- */
/* Demi-ouvert                                                                */
/* -------------------------------------------------------------------------- */

test("après le délai, UNE seule sonde passe", () => {
  // Laisser passer tout le trafic à la réouverture réabattrait le service qui
  // vient à peine de revenir.
  const { cb, clock } = make({ failureThreshold: 1, openMs: 30_000 });

  cb.onFailure(KEY, { status: 503 });
  clock.advance(30_001);

  const first = cb.canRequest(KEY);
  assert.equal(first.allowed, true);
  assert.equal(first.probe, true);
  assert.equal(first.state, "half_open");

  const second = cb.canRequest(KEY);
  assert.equal(second.allowed, false, "la deuxième requête doit être refusée");
});

test("une sonde réussie referme le disjoncteur", () => {
  const { cb, clock } = make({ failureThreshold: 1, openMs: 30_000 });

  cb.onFailure(KEY, { status: 503 });
  clock.advance(30_001);
  cb.canRequest(KEY);
  cb.onSuccess(KEY);

  assert.equal(cb.inspect(KEY).state, "closed");
  assert.equal(cb.canRequest(KEY).allowed, true);
});

test("une sonde ratée rouvre, PLUS LONGTEMPS", () => {
  // Sans recul, un incident long se traduirait par une sonde toutes les 30 s
  // indéfiniment.
  const { cb, clock } = make({ failureThreshold: 1, openMs: 30_000, maxOpenMs: 300_000 });

  cb.onFailure(KEY, { status: 503 });
  const first = cb.inspect(KEY).openMs;

  clock.advance(30_001);
  cb.canRequest(KEY);
  cb.onFailure(KEY, { status: 503 });

  assert.equal(cb.inspect(KEY).state, "open");
  assert.equal(cb.inspect(KEY).openMs, first * 2);
});

test("le recul est plafonné", () => {
  const { cb, clock } = make({ failureThreshold: 1, openMs: 30_000, maxOpenMs: 120_000 });

  cb.onFailure(KEY, { status: 503 });

  for (let i = 0; i < 10; i += 1) {
    clock.advance(10 * 60_000);
    cb.canRequest(KEY);
    cb.onFailure(KEY, { status: 503 });
  }

  assert.equal(cb.inspect(KEY).openMs, 120_000);
});

test("refermer remet le recul à zéro", () => {
  const { cb, clock } = make({ failureThreshold: 1, openMs: 30_000 });

  cb.onFailure(KEY, { status: 503 });
  clock.advance(30_001);
  cb.canRequest(KEY);
  cb.onFailure(KEY, { status: 503 });
  assert.equal(cb.inspect(KEY).openMs, 60_000);

  clock.advance(60_001);
  cb.canRequest(KEY);
  cb.onSuccess(KEY);

  assert.equal(cb.inspect(KEY).openMs, 30_000);
});

/* -------------------------------------------------------------------------- */
/* Retry-After                                                                */
/* -------------------------------------------------------------------------- */

test("Retry-After l'emporte sur le seuil", () => {
  // Quand le fournisseur dit explicitement « reviens dans N secondes »,
  // insister est inutile et aggrave sa situation.
  const { cb } = make({ failureThreshold: 5 });

  cb.onFailure(KEY, { status: 429, retryAfterSec: 90 });

  const st = cb.inspect(KEY);
  assert.equal(st.state, "open");
  assert.ok(st.retryAfterSec >= 89 && st.retryAfterSec <= 90);
});

/* -------------------------------------------------------------------------- */
/* Isolation                                                                  */
/* -------------------------------------------------------------------------- */

test("chaque fournisseur a son propre disjoncteur", () => {
  // Sans cela, une panne d'un fournisseur couperait tous les autres.
  const { cb } = make({ failureThreshold: 1 });
  const OTHER = "https://provider-b.example";

  cb.onFailure(KEY, { status: 503 });

  assert.equal(cb.canRequest(KEY).allowed, false);
  assert.equal(cb.canRequest(OTHER).allowed, true);
});

test("un fournisseur jamais vu est fermé, pas inconnu", () => {
  const { cb } = make();

  assert.equal(cb.inspect("https://jamais-vu").state, "closed");
  assert.equal(cb.canRequest("https://jamais-vu").allowed, true);
});

test("snapshot expose l'état de tous les circuits", () => {
  const { cb } = make({ failureThreshold: 1 });

  cb.onFailure("https://a", { status: 503 });
  cb.onFailure("https://b", { status: 502 });

  const snap = cb.snapshot();
  assert.equal(snap.length, 2);
  assert.ok(snap.every((c) => c.state === "open"));
});
