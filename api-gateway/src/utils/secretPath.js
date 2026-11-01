"use strict";

/**
 * Un jeton à usage unique voyage dans l'URL : il ne doit pas rester lisible dans
 * un journal (règle B.4). La base n'en garde que l'empreinte.
 */
const SECRET_PATHS = /(\/api\/v1\/(?:demo-invitations|sandbox\/3ds)\/)[^/?#\s]+/g;

function redactSecretPath(url) {
  return String(url ?? "").replace(SECRET_PATHS, "$1[jeton]");
}

module.exports = { redactSecretPath };
