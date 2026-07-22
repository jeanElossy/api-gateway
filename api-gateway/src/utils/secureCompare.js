// File: src/utils/secureCompare.js
"use strict";

const crypto = require("crypto");

/**
 * Comparaison de secrets à temps constant.
 *
 * Une comparaison `===` sur une chaîne s'arrête au premier caractère différent :
 * le temps de réponse dépend alors de la longueur du préfixe correct, ce qui
 * permet en théorie de reconstruire un token octet par octet. Le backend
 * principal utilisait déjà `crypto.timingSafeEqual` ; ce helper aligne le
 * gateway sur la même règle.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean} false si l'un est vide ou si les longueurs diffèrent.
 */
function secureCompare(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");

  // timingSafeEqual exige des longueurs égales ; une différence de longueur
  // n'est de toute façon pas un secret exploitable.
  if (aa.length !== bb.length || aa.length === 0) return false;

  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

module.exports = { secureCompare };
