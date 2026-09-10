// File: middlewares/validateTransaction.js
"use strict";

const Joi = require("joi");
const logger = require("../logger");
const allowedFlows = require("../tools/allowedFlows");

/**
 * --------------------------------------------------------------------------
 * Validation transaction gateway
 * --------------------------------------------------------------------------
 * Objectifs :
 * - valider les payloads user avant routage
 * - préserver les champs nécessaires au TX Core / provider
 * - déduire action/providerSelected quand possible
 *
 * IMPORTANT :
 * - initiate = validation la plus riche
 * - confirm/cancel/admin = validation plus souple pour laisser
 *   le gateway résoudre le flow réel depuis la transaction canonique
 * - les vérifications email/téléphone/KYC/KYB doivent rester dans
 *   requireTransactionEligibility, pas ici.
 * --------------------------------------------------------------------------
 */

/**
 * Les rails que le produit opère. Toute autre valeur est refusée par Joi.
 *
 * `stripe`, `bank`, `stripe2momo` et `flutterwave` en ont été retirés le
 * 2026-09-08 : les trois premiers ne sont plus au périmètre, et `flutterwave`
 * n'est pas un rail mais un opérateur — il se sert derrière `mobilemoney`, et
 * lui laisser une entrée de rail ouvrait un second chemin vers le même argent,
 * hors des plafonds du rail mobile money.
 *
 * `card` est accepté comme ALIAS de `visa_direct` : le partenaire carte à venir
 * sert Visa, Mastercard et les autres réseaux, et le rail ne doit pas porter le
 * nom d'un seul d'entre eux.
 */
const PROVIDERS = ["paynoval", "mobilemoney", "visa_direct", "card"];

/** Opérateurs du rail mobile money — des prestataires, pas des rails. */
const MOBILEMONEY_OPERATORS = ["orange", "mtn", "moov", "wave"];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function low(v) {
  return String(v || "").toLowerCase().trim();
}

function normalizeProviderLike(v) {
  const s = low(v);

  // Le rail carte, quel que soit le réseau ou le nom qu'on lui donne.
  if (["visadirect", "visa-direct", "visa", "card", "mastercard"].includes(s)) {
    return "visa_direct";
  }

  if (["mobile_money", "mobile-money", "momo"].includes(s)) return "mobilemoney";

  return s;
}

function normalizeRailLike(v) {
  const s = normalizeProviderLike(v);

  if (["stripe", "visa_direct", "card"].includes(s)) return "card";

  if (["wave", "orange", "mtn", "moov", "flutterwave"].includes(s)) {
    return "mobilemoney";
  }

  return s;
}

/**
 * computeProviderSelected(action, funds, destination)
 * - deposit  => providerSelected = funds
 * - withdraw => providerSelected = destination
 * - send     => providerSelected = destination
 */
function computeProviderSelected(action, funds, destination) {
  const a = low(action);
  const f = normalizeProviderLike(funds);
  const d = normalizeProviderLike(destination);

  if (a === "deposit") return f;
  if (a === "withdraw") return d;
  if (a === "send") return d;

  const candidates = allowedFlows.filter(
    (x) =>
      normalizeRailLike(x.funds) === normalizeRailLike(f) &&
      normalizeRailLike(x.destination) === normalizeRailLike(d)
  );

  if (candidates.length === 1 && candidates[0].action) {
    const inferredAction = low(candidates[0].action);
    if (inferredAction === "deposit") return f;
    return d;
  }

  return d;
}

function inferActionIfMissing(action, funds, destination) {
  const a = low(action);

  if (["send", "deposit", "withdraw"].includes(a)) return a;

  const f = normalizeRailLike(funds);
  const d = normalizeRailLike(destination);

  const candidates = allowedFlows.filter(
    (x) =>
      normalizeRailLike(x.funds) === f &&
      normalizeRailLike(x.destination) === d
  );

  if (candidates.length === 1 && candidates[0].action) {
    const inferred = low(candidates[0].action);

    if (["send", "deposit", "withdraw"].includes(inferred)) {
      return inferred;
    }
  }

  return "send";
}

function resolveCurrencyForLimits(body = {}) {
  return (
    body.currencySource ||
    body.senderCurrencyCode ||
    body.currencyCode ||
    body.currencySender ||
    body.currency ||
    body.selectedCurrency ||
    body.money?.source?.currency ||
    "USD"
  );
}

function resolveCountryCompat(body = {}, user = {}) {
  return (
    body.country ||
    body.destinationCountry ||
    body.countryTarget ||
    body.originCountry ||
    body.fromCountry ||
    body.senderCountry ||
    user?.selectedCountry ||
    user?.country ||
    user?.countryCode ||
    ""
  );
}

function hasTruthy(v) {
  return !(v === undefined || v === null || String(v).trim() === "");
}

function normalizeSecurityAliases(body = {}) {
  if (!body || typeof body !== "object") return body;

  if (!body.question && body.securityQuestion) {
    body.question = body.securityQuestion;
  }

  if (!body.securityQuestion && body.question) {
    body.securityQuestion = body.question;
  }

  if (!body.securityCode && body.securityAnswer) {
    body.securityCode = body.securityAnswer;
  }

  if (!body.securityCode && body.validationCode) {
    body.securityCode = body.validationCode;
  }

  if (!body.securityAnswer && body.securityCode) {
    body.securityAnswer = body.securityCode;
  }

  return body;
}

/* -------------------------------------------------------------------------- */
/* Meta schema à préserver                                                    */
/* -------------------------------------------------------------------------- */

const txMetaSchema = {
  amountSource: Joi.number().min(0).optional(),
  amountTarget: Joi.number().min(0).optional(),
  localAmount: Joi.number().min(0).optional(),
  netAmount: Joi.number().min(0).optional(),
  feeAmount: Joi.number().min(0).optional(),

  amountReceived: Joi.number().min(0).optional(),
  receivedAmount: Joi.number().min(0).optional(),
  recipientAmount: Joi.number().min(0).optional(),

  feeSource: Joi.number().min(0).optional(),
  feeTarget: Joi.number().min(0).optional(),

  exchangeRate: Joi.number().min(0).optional(),
  fxRate: Joi.number().min(0).optional(),
  fxRateSourceToTarget: Joi.number().min(0).optional(),

  currencySource: Joi.string().max(12).optional(),
  currencyTarget: Joi.string().max(12).optional(),
  currency: Joi.string().max(12).optional(),
  selectedCurrency: Joi.string().max(12).optional(),
  currencySender: Joi.string().max(12).optional(),
  currencyCode: Joi.string().max(12).optional(),
  senderCurrencyCode: Joi.string().max(12).optional(),
  senderCurrencySymbol: Joi.string().max(16).optional(),
  localCurrencyCode: Joi.string().max(12).optional(),
  localCurrencySymbol: Joi.string().max(16).optional(),

  country: Joi.string().max(64).optional(),
  destinationCountry: Joi.string().max(64).optional(),
  senderCountry: Joi.string().max(64).optional(),
  originCountry: Joi.string().max(64).optional(),
  fromCountry: Joi.string().max(64).optional(),
  sourceCountry: Joi.string().max(64).optional(),
  toCountry: Joi.string().max(64).optional(),
  targetCountry: Joi.string().max(64).optional(),
  countryTarget: Joi.string().max(64).optional(),

  transactionFees: Joi.number().min(0).optional(),

  recipientInfo: Joi.object().unknown(true).optional(),
  metadata: Joi.object().unknown(true).optional(),
  meta: Joi.object().unknown(true).optional(),
  pricingSnapshot: Joi.object().unknown(true).optional(),
  money: Joi.object().unknown(true).optional(),

  toName: Joi.string().max(128).optional(),
  toBank: Joi.string().max(128).optional(),
  recipientName: Joi.string().max(128).optional(),
  reference: Joi.string().max(128).optional(),

  quoteId: Joi.string().max(128).optional(),
  pricingId: Joi.string().max(128).optional(),
  pricingLockId: Joi.string().max(128).optional(),
  lockId: Joi.string().max(128).optional(),
  pricingQuoteId: Joi.string().max(128).optional(),
  effectivePricingId: Joi.string().max(128).optional(),

  method: Joi.string().max(64).optional(),
  methodType: Joi.string().max(64).optional(),
  txType: Joi.string().max(64).optional(),
  transactionType: Joi.string().max(64).optional(),

  fundsUi: Joi.string().max(64).optional(),
  destinationUi: Joi.string().max(64).optional(),
  providerSelected: Joi.string().max(64).optional(),
  rail: Joi.string().max(64).optional(),

  providerReference: Joi.string().max(128).optional(),
  providerTxId: Joi.string().max(128).optional(),
  idempotencyKey: Joi.string().max(128).optional(),
};

const baseInitiateSchema = {
  funds: Joi.string().valid(...PROVIDERS).required(),
  destination: Joi.string().valid(...PROVIDERS).required(),
  amount: Joi.number().min(1).required(),
  provider: Joi.string().optional(),
  action: Joi.string().valid("send", "deposit", "withdraw").optional(),
  ...txMetaSchema,
};

/* -------------------------------------------------------------------------- */
/* Initiate schemas                                                           */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ UN SCHÉMA PAR RAIL DU PÉRIMÈTRE, ET RIEN D'AUTRE.
 *
 * Quatre schémas ont été retirés le 2026-09-10 — `bank`, `stripe`,
 * `stripe2momo`, `flutterwave`. Leurs rails avaient quitté le périmètre
 * (le bancaire le 2026-08-26, Stripe le 2026-09-09), mais leurs schémas de
 * validation étaient restés.
 *
 * Ce n'était pas inerte. `initiateSchemas[providerSelected]` les retrouvait,
 * et une charge bancaire recevait donc un verdict « bien formée » avant d'être
 * refusée plus loin par le routage. Une validation qui approuve ce que le
 * moteur refusera n'informe personne : elle déplace juste l'échec plus tard,
 * dans un message qui ne dit plus pourquoi.
 *
 * Périmètre de lancement arrêté : **PayNoval interne, mobile money, carte Visa**.
 * Un `providerSelected` hors de ces trois ne trouve plus de schéma — la
 * validation générique s'applique, et le routage refuse.
 */
const initiateSchemas = {
  paynoval: Joi.object({
    ...baseInitiateSchema,
    toEmail: Joi.string().email().required(),
    message: Joi.string().max(256).optional(),
    question: Joi.string().max(128).required(),
    securityQuestion: Joi.string().max(128).optional(),
    securityCode: Joi.string().trim().min(1).max(64).required(),
    securityAnswer: Joi.string().trim().min(1).max(128).optional(),
    validationCode: Joi.string().trim().min(1).max(64).optional(),
    country: Joi.string().max(64).required(),
    description: Joi.string().max(500).optional(),
  }),


  mobilemoney: Joi.object({
    ...baseInitiateSchema,
    phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
    operator: Joi.string().valid(...MOBILEMONEY_OPERATORS).required(),
    recipientName: Joi.string().max(64).optional(),
    country: Joi.string().max(64).required(),
  }),


  visa_direct: Joi.object({
    ...baseInitiateSchema,
    cardNumber: Joi.string().creditCard().required(),
    cardHolder: Joi.string().max(64).required(),
    expMonth: Joi.number().min(1).max(12).required(),
    expYear: Joi.number()
      .min(new Date().getFullYear())
      .max(new Date().getFullYear() + 20)
      .required(),
    cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
    toName: Joi.string().max(128).required(),
    toBank: Joi.string().max(128).optional(),
    country: Joi.string().max(64).optional(),
  }),


};

/* -------------------------------------------------------------------------- */
/* Action schemas                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Pour confirm/cancel/admin :
 * - provider n'est PAS requis
 * - le gateway peut le déduire depuis la transaction canonique
 * - confirm exige au moins une réponse de sécurité non vide
 */
const confirmSchema = Joi.object({
  transactionId: Joi.string().required(),
  provider: Joi.string().valid(...PROVIDERS).optional(),

  securityCode: Joi.string().trim().min(1).max(64).empty("").optional(),
  securityAnswer: Joi.string().trim().min(1).max(128).empty("").optional(),
  code: Joi.string().trim().min(1).max(64).empty("").optional(),

  reference: Joi.string().max(128).optional(),
  metadata: Joi.object().unknown(true).optional(),
  meta: Joi.object().unknown(true).optional(),
})
  .or("securityCode", "securityAnswer", "code")
  .unknown(false);

const cancelSchema = Joi.object({
  transactionId: Joi.string().required(),
  provider: Joi.string().valid(...PROVIDERS).optional(),
  reason: Joi.string().max(500).optional(),
  metadata: Joi.object().unknown(true).optional(),
  meta: Joi.object().unknown(true).optional(),
}).unknown(false);

const adminActionSchema = Joi.object({
  transactionId: Joi.string().required(),
  provider: Joi.string().valid(...PROVIDERS).optional(),
  reason: Joi.string().max(500).optional(),
  status: Joi.string().max(64).optional(),
  adminNote: Joi.string().max(2000).optional(),
  newReceiverEmail: Joi.string().email().optional(),
  metadata: Joi.object().unknown(true).optional(),
  meta: Joi.object().unknown(true).optional(),
}).unknown(false);

/* -------------------------------------------------------------------------- */
/* Middleware                                                                 */
/* -------------------------------------------------------------------------- */

function validateTransaction(action) {
  return function (req, res, next) {
    const body = req.body || {};

    normalizeSecurityAliases(body);

    const funds = body.funds;
    const destination = body.destination;

    const actionTx = inferActionIfMissing(body.action, funds, destination);
    const providerSelected = computeProviderSelected(
      actionTx,
      funds,
      destination
    );

    if (action === "initiate" && providerSelected === "paynoval") {
      if (!body.question && body.securityQuestion) {
        body.question = body.securityQuestion;
      }

      if (!body.securityCode && body.securityAnswer) {
        body.securityCode = body.securityAnswer;
      }

      if (!body.securityCode && body.validationCode) {
        body.securityCode = body.validationCode;
      }

      if (!body.country) {
        body.country = resolveCountryCompat(body, req.user || {});
      }

      if (!body.senderCountry) {
        body.senderCountry =
          req.user?.selectedCountry ||
          req.user?.country ||
          req.user?.countryCode ||
          "";
      }

      if (!body.method) {
        body.method = body.methodType === "internal" ? "INTERNAL" : "INTERNAL";
      }

      if (!body.txType) {
        body.txType = body.transactionType || "TRANSFER";
      }
    }

    /**
     * ⚠️ LE PLAFOND DE CONFORMITÉ N'EST PLUS APPLIQUÉ ICI — 2026-09-10.
     *
     * `getSingleTxLimit` était tissé dans le schéma Joi (`amount.max(maxLimit)`),
     * ce qui faisait rendre au bord une erreur 400 de VALIDATION là où il
     * s'agissait d'une décision de CONFORMITÉ. Les deux ne se traitent pas
     * pareil : la première dit « votre requête est malformée », la seconde
     * « votre opération dépasse un plafond réglementaire ». Le mobile ne
     * pouvait pas les distinguer.
     *
     * Le plafond est appliqué par l'AML unique de Tx-Core
     * (`api-paynoval/src/middleware/aml.js:994`), qui rend un 403
     * `AML_SINGLE_LIMIT` portant le plafond applicable.
     *
     * ── Ce qui reste ici, et pourquoi ce n'est PAS un plafond ───────────────
     *
     * Une borne NUMÉRIQUE, pas réglementaire. Sans elle, un client pourrait
     * envoyer `amount: 1e300` : le nombre traverserait la validation, la
     * sérialisation JSON et le relais avant que quiconque le regarde, et les
     * calculs intermédiaires perdraient toute précision bien avant d'atteindre
     * le contrôle. Borner la magnitude est de la validation de forme — le
     * travail du bord ; décider d'un montant maximal autorisé ne l'est pas.
     */
    const BORNE_NUMERIQUE = 1e15;
    let currencyForMsg = "F CFA";

    if (action === "initiate") {
      currencyForMsg = resolveCurrencyForLimits(body) || currencyForMsg;
    }

    let schema;

    if (action === "initiate" && initiateSchemas[providerSelected]) {
      schema = initiateSchemas[providerSelected].keys({
        amount: Joi.number().min(1).less(BORNE_NUMERIQUE).required(),
        action: Joi.string().valid("send", "deposit", "withdraw").optional(),
      });
    } else if (action === "confirm") {
      schema = confirmSchema;
    } else if (action === "cancel") {
      schema = cancelSchema;
    } else if (
      ["refund", "reassign", "validate", "archive", "relaunch"].includes(action)
    ) {
      schema = adminActionSchema;
    }

    if (!schema) {
      logger.warn("[validateTransaction] Provider/action non supporté", {
        providerSelected,
        destination,
        funds,
        action,
        ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
      });

      return res.status(400).json({
        success: false,
        error: "Provider ou action non supporté.",
        details: [],
      });
    }

    const { error, value } = schema.validate(body, {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      let details = error.details.map((d) => d.message);

      details = details.map((msg) => {
        if (/less than or equal to (\d+)/i.test(msg)) {
          return msg.replace(
            /less than or equal to (\d+)/i,
            (_m, p1) => `less than or equal to ${p1} ${currencyForMsg}`
          );
        }

        if (msg.includes("must contain at least one of")) {
          return "La réponse de sécurité est requise pour confirmer la transaction.";
        }

        return msg;
      });

      logger.warn(
        `[validateTransaction][${providerSelected}] Validation failed (${action})`,
        {
          details,
          ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
          email: value?.toEmail || null,
        }
      );

      return res.status(400).json({
        success: false,
        error: "Données invalides",
        details,
      });
    }

    req.body = value;

    if (action === "initiate") {
      req.body.action = inferActionIfMissing(
        req.body.action,
        req.body.funds,
        req.body.destination
      );

      req.providerSelected = computeProviderSelected(
        req.body.action,
        req.body.funds,
        req.body.destination
      );

      req.body.provider = req.body.provider || req.providerSelected;
      req.body.providerSelected = req.providerSelected;

      if (req.providerSelected === "paynoval") {
        if (!req.body.question && req.body.securityQuestion) {
          req.body.question = req.body.securityQuestion;
        }

        if (!req.body.securityQuestion && req.body.question) {
          req.body.securityQuestion = req.body.question;
        }

        if (!req.body.securityCode && req.body.securityAnswer) {
          req.body.securityCode = req.body.securityAnswer;
        }

        if (!req.body.securityAnswer && req.body.securityCode) {
          req.body.securityAnswer = req.body.securityCode;
        }

        if (!req.body.country) {
          req.body.country = resolveCountryCompat(req.body, req.user || {});
        }

        if (!req.body.method) {
          req.body.method = "INTERNAL";
        }

        if (!req.body.methodType) {
          req.body.methodType = "internal";
        }

        if (!req.body.txType) {
          req.body.txType = "TRANSFER";
        }

        if (!req.body.transactionType) {
          req.body.transactionType = "transfer";
        }

        if (!req.body.fundsUi) {
          req.body.fundsUi = "paynoval";
        }

        if (!req.body.destinationUi) {
          req.body.destinationUi = "paynoval";
        }
      }

      const match = allowedFlows.find(
        (f) =>
          normalizeRailLike(f.funds) === normalizeRailLike(req.body.funds) &&
          normalizeRailLike(f.destination) ===
            normalizeRailLike(req.body.destination) &&
          (!f.action || low(f.action) === low(req.body.action))
      );

      if (!match) {
        logger.warn("[validateTransaction] Flux funds/destination non autorisé", {
          funds: req.body.funds,
          destination: req.body.destination,
          action: req.body.action,
          ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
        });

        return res.status(400).json({
          success: false,
          error: "Ce flux funds/destination n'est pas autorisé.",
          details: [],
        });
      }

      req.routedProvider = req.providerSelected;

      /**
       * ⚠️ LE CUMUL JOURNALIER N'EST PLUS VÉRIFIÉ ICI — 2026-09-10.
       *
       * Ce bloc était le TROISIÈME exemplaire des plafonds de conformité :
       * `middlewares/aml.js` du bord les appliquait déjà, et
       * `api-paynoval/src/middleware/aml.js` les applique toujours
       * (`aml.js:994` pour l'unitaire, `:1030` pour le journalier). Trois
       * implémentations d'une même règle ne restent pas d'accord.
       *
       * Il portait en outre deux défauts que le déplacement referme :
       *
       *   · il agrégeait la collection `Transaction`, qui appartient à Tx-Core,
       *     depuis la passerelle — la même classe de faute que R-06 sur les
       *     portefeuilles ;
       *   · son `catch` LAISSAIT PASSER la transaction quand la lecture des
       *     statistiques échouait. Le commentaire le nommait honnêtement comme
       *     un repli ouvert assumé, mais c'en était un sur le chemin de
       *     l'argent (règle B.2). Tx-Core, lui, échoue en fermeture.
       *
       * Le refus arrive maintenant de Tx-Core en 403 `AML_DAILY_LIMIT`, avec le
       * plafond applicable — plus informatif que le 403 générique rendu ici.
       */
      return next();
    }

    if (action === "confirm") {
      if (!req.body.securityCode && req.body.code) {
        req.body.securityCode = req.body.code;
      }

      if (!req.body.securityAnswer && req.body.securityCode) {
        req.body.securityAnswer = req.body.securityCode;
      }
    }

    if (
      [
        "confirm",
        "cancel",
        "refund",
        "reassign",
        "validate",
        "archive",
        "relaunch",
      ].includes(action)
    ) {
      if (!hasTruthy(req.body.provider)) {
        delete req.body.provider;
      } else {
        req.body.provider = normalizeProviderLike(req.body.provider);
      }
    }

    return next();
  };
}

module.exports = validateTransaction;