"use strict";

/**
 * REFUS D'UN COMPTE RESTREINT SUR UNE ROUTE PROXIFIÉE
 * -----------------------------------------------------------------------------
 * `requireTransactionEligibility` n'est monté que sur les routes de transaction
 * natives du gateway. Les autres surfaces sensibles — la création de cagnotte
 * notamment — sont **proxifiées** vers le backend principal : elles traversent
 * bien le gateway, mais sans passer par ce middleware.
 *
 * Ce garde comble ce trou sans imposer les contrôles complets d'éligibilité
 * (KYC, e-mail, téléphone) à des routes qui ne les exigeaient pas : il ne
 * regarde qu'une chose, l'état du compte.
 *
 * Aucun appel réseau : `authMiddleware` a déjà chargé l'utilisateur depuis la
 * base users, `req.user.accountStatus` est donc disponible.
 *
 * ⚠️ FAIL-OPEN ASSUMÉ. Si l'état du compte est absent — utilisateur non chargé,
 * appel interne de service à service — le garde laisse passer. Le backend
 * principal refait le contrôle : c'est lui qui fait autorité. Bloquer ici sur
 * une donnée manquante couperait des parcours légitimes pour une raison
 * technique.
 */

function normalizeStatus(value) {
  return String(value ?? "").trim().toLowerCase();
}

const MESSAGE =
  "Votre compte fait l'objet de signalements : cette opération est temporairement suspendue. Vos retraits restent disponibles.";

/**
 * @param {object} options
 * @param {string[]} [options.methods]  Méthodes HTTP concernées.
 * @param {RegExp[]} [options.paths]    Chemins concernés, **relatifs au point de
 *   montage**. Obligatoire en pratique : un garde qui intercepte toutes les
 *   écritures d'un préfixe bloque aussi ce qui doit rester ouvert — clôturer sa
 *   propre cagnotte, se désabonner, ou un webkook de provider.
 */
module.exports = function requireNotRestricted({
  methods = ["POST"],
  paths = null,
} = {}) {
  const wanted = methods.map((m) => String(m).toUpperCase());

  return function requireNotRestrictedMiddleware(req, res, next) {
    if (!wanted.includes(req.method)) return next();

    if (Array.isArray(paths) && !paths.some((re) => re.test(req.path))) {
      return next();
    }

    const status = normalizeStatus(req.user?.accountStatus);

    if (status !== "restricted") return next();

    return res.status(403).json({
      success: false,
      code: "ACCOUNT_RESTRICTED",
      error: MESSAGE,
      message: MESSAGE,
    });
  };
};

module.exports.MESSAGE = MESSAGE;
