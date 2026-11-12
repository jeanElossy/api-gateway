"use strict";

/**
 * Un jeton à usage unique voyage dans l'URL : il ne doit pas rester lisible dans
 * un journal (règle B.4). La base n'en garde que l'empreinte.
 *
 * Couverts : invitation de démonstration, page 3DS de test, et depuis le
 * 2026-11-12 les jetons d'authentification — vérification de l'e-mail
 * (`/auth/verify-email/<jeton>`), du téléphone (`/auth/verify-phone/<jeton>`)
 * et réinitialisation du mot de passe (`/auth/reset-password/<jeton>`). Ils
 * valent autorisation : un journal qui les garde en clair les distribue.
 * Même liste que l'application mobile (`payNoval-master/utils/secretPath.js`).
 */
const SECRET_PATHS =
  /(\/api\/v1\/(?:demo-invitations\/signup|demo-invitations|sandbox\/3ds|auth\/verify-email|auth\/verify-phone|auth\/reset-password)\/)[^/?#\s]+/g;

function redactSecretPath(url) {
  return String(url ?? "").replace(SECRET_PATHS, "$1[jeton]");
}

module.exports = { redactSecretPath };
