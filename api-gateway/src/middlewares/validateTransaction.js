// // File: middlewares/validateTransaction.js

// const Joi = require("joi");
// const logger = require("../logger");
// const allowedFlows = require("../tools/allowedFlows");
// const { getSingleTxLimit, getDailyLimit } = require("../tools/amlLimits");
// const { getUserTransactionsStats } = require("../services/aml"); // Doit exister

// /**
//  * ----------------------------------------------------------
//  * computeProviderSelected(action, funds, destination)
//  * - deposit  => providerSelected = funds
//  * - withdraw => providerSelected = destination
//  * - send     => providerSelected = destination
//  *
//  * Compat front:
//  * - si action est manquant => on tente de déduire via allowedFlows
//  * - sinon fallback "send"
//  * ----------------------------------------------------------
//  */
// function computeProviderSelected(action, funds, destination) {
//   const a = String(action || "").toLowerCase().trim();
//   const f = String(funds || "").toLowerCase().trim();
//   const d = String(destination || "").toLowerCase().trim();

//   if (a === "deposit") return f;
//   if (a === "withdraw") return d;
//   if (a === "send") return d;

//   const candidates = allowedFlows.filter((x) => x.funds === f && x.destination === d);
//   if (candidates.length === 1 && candidates[0].action) {
//     const inferredAction = String(candidates[0].action).toLowerCase().trim();
//     if (inferredAction === "deposit") return f;
//     return d;
//   }

//   return d;
// }

// function inferActionIfMissing(action, funds, destination) {
//   const a = String(action || "").toLowerCase().trim();
//   if (a === "send" || a === "deposit" || a === "withdraw") return a;

//   const f = String(funds || "").toLowerCase().trim();
//   const d = String(destination || "").toLowerCase().trim();

//   const candidates = allowedFlows.filter((x) => x.funds === f && x.destination === d);
//   if (candidates.length === 1 && candidates[0].action) {
//     const inferred = String(candidates[0].action).toLowerCase().trim();
//     if (inferred === "send" || inferred === "deposit" || inferred === "withdraw") return inferred;
//   }

//   return "send";
// }

// const PROVIDERS = [
//   "paynoval",
//   "stripe",
//   "bank",
//   "mobilemoney",
//   "visa_direct",
//   "stripe2momo",
//   "flutterwave",
// ];

// /**
//  * ✅ Champs "meta" qu'on DOIT garder (sinon stripUnknown les supprime
//  * et AML retombe sur country/destination => mauvaise devise).
//  */
// const txMetaSchema = {
//   // Montants source/target + fees
//   amountSource: Joi.number().min(0).optional(),
//   amountTarget: Joi.number().min(0).optional(),
//   feeSource: Joi.number().min(0).optional(),
//   feeTarget: Joi.number().min(0).optional(),

//   // FX
//   exchangeRate: Joi.number().min(0).optional(),
//   fxRate: Joi.number().min(0).optional(),
//   fxRateSourceToTarget: Joi.number().min(0).optional(),

//   // Devise ISO / symboles
//   currencySource: Joi.string().max(8).optional(),
//   currencyTarget: Joi.string().max(8).optional(),
//   currency: Joi.string().max(8).optional(),
//   selectedCurrency: Joi.string().max(8).optional(),
//   currencySender: Joi.string().max(8).optional(),
//   currencyCode: Joi.string().max(8).optional(),
//   senderCurrencyCode: Joi.string().max(8).optional(),
//   senderCurrencySymbol: Joi.string().max(12).optional(),
//   localCurrencyCode: Joi.string().max(8).optional(),
//   localCurrencySymbol: Joi.string().max(12).optional(),

//   // Pays (destination vs sender)
//   country: Joi.string().max(64).optional(),
//   destinationCountry: Joi.string().max(64).optional(),
//   senderCountry: Joi.string().max(64).optional(),
//   originCountry: Joi.string().max(64).optional(),
//   fromCountry: Joi.string().max(64).optional(),

//   // Frais côté app
//   transactionFees: Joi.number().min(0).optional(),

//   // Divers compat front
//   recipientInfo: Joi.object().unknown(true).optional(),
//   toName: Joi.string().max(128).optional(),
//   toBank: Joi.string().max(128).optional(),
//   recipientName: Joi.string().max(128).optional(),
// };

// const baseSchema = {
//   funds: Joi.string().valid(...PROVIDERS).required(),
//   destination: Joi.string().valid(...PROVIDERS).required(),

//   // Le max sera injecté dynamiquement via .keys() plus bas
//   amount: Joi.number().min(1).required(),

//   provider: Joi.string().optional(),
//   action: Joi.string().valid("send", "deposit", "withdraw").optional(),

//   // ✅ garder les meta partout (sinon stripUnknown les supprime)
//   ...txMetaSchema,
// };

// // ✅ Résout la devise pour les limites AML (priorité "source/sender")
// function resolveCurrencyForLimits(body = {}) {
//   const cand =
//     body.currencySource ||
//     body.senderCurrencyCode ||
//     body.currencyCode ||
//     body.currencySender ||
//     body.currency ||
//     body.selectedCurrency ||
//     "";
//   return cand || "USD";
// }

// const initiateSchemas = {
//   paynoval: Joi.object({
//     ...baseSchema,
//     toEmail: Joi.string().email().required(),
//     message: Joi.string().max(256).optional(),

//     // microservice paynoval exige question + securityCode
//     question: Joi.string().max(128).required(),
//     securityQuestion: Joi.string().max(128).optional(),

//     securityCode: Joi.string().max(32).required(),

//     /**
//      * ⚠️ IMPORTANT:
//      * Ton front envoie souvent country = "france" (destination).
//      * Ton microservice attend "country" (souvent destination).
//      * Donc on accepte country, MAIS on accepte aussi destinationCountry
//      * et on mappera destinationCountry -> country si besoin.
//      */
//     country: Joi.string().max(64).required(),

//     // ✅ garder ces champs (ils étaient déjà dans txMetaSchema, mais c'est OK de les laisser aussi)
//     recipientInfo: Joi.object().unknown(true).optional(),
//   }),

//   stripe: Joi.object({
//     ...baseSchema,
//     currency: Joi.string().length(3).uppercase().required(),
//     cardNumber: Joi.string().creditCard().required(),
//     expMonth: Joi.number().min(1).max(12).required(),
//     expYear: Joi.number()
//       .min(new Date().getFullYear())
//       .max(new Date().getFullYear() + 20)
//       .required(),
//     cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
//     cardHolder: Joi.string().max(64).required(),

//     toEmail: Joi.string().email().optional(),
//   }),

//   mobilemoney: Joi.object({
//     ...baseSchema,
//     phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
//     operator: Joi.string().valid("orange", "mtn", "moov", "wave").required(),
//     recipientName: Joi.string().max(64).optional(),

//     // ici country = pays de destination momo
//     country: Joi.string().max(64).required(),
//   }),

//   bank: Joi.object({
//     ...baseSchema,
//     iban: Joi.string().pattern(/^[A-Z0-9]{15,34}$/).required(),
//     bankName: Joi.string().max(128).required(),
//     accountHolder: Joi.string().max(128).required(),
//     country: Joi.string().max(64).required(),
//     swift: Joi.string().pattern(/^[A-Z0-9]{8,11}$/).optional(),
//   }),

//   visa_direct: Joi.object({
//     ...baseSchema,
//     cardNumber: Joi.string().creditCard().required(),
//     cardHolder: Joi.string().max(64).required(),
//     expMonth: Joi.number().min(1).max(12).required(),
//     expYear: Joi.number()
//       .min(new Date().getFullYear())
//       .max(new Date().getFullYear() + 20)
//       .required(),
//     cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
//     toName: Joi.string().max(128).required(),
//     toBank: Joi.string().max(128).optional(),
//     country: Joi.string().max(64).optional(),
//   }),

//   stripe2momo: Joi.object({
//     ...baseSchema,
//     phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
//     operator: Joi.string().valid("orange", "mtn", "moov", "wave").required(),
//     country: Joi.string().max(64).required(),
//     stripeRef: Joi.string().max(128).optional(),
//   }),

//   flutterwave: Joi.object({
//     ...baseSchema,
//     currency: Joi.string().length(3).uppercase().required(),
//     phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
//     operator: Joi.string().max(64).optional(),
//     recipientName: Joi.string().max(128).optional(),
//     country: Joi.string().max(64).required(),
//     bankCode: Joi.string().max(32).optional(),
//     accountNumber: Joi.string().max(32).optional(),
//   }),
// };

// const confirmSchema = Joi.object({
//   provider: Joi.string().valid(...PROVIDERS).required(),
//   transactionId: Joi.string().required(),

//   securityCode: Joi.string().max(32).allow("").optional(),
//   code: Joi.string().max(32).allow("").optional(),

//   reference: Joi.string().max(128).optional(),
// }).unknown(false);

// const cancelSchema = Joi.object({
//   provider: Joi.string().valid(...PROVIDERS).required(),
//   transactionId: Joi.string().required(),
// }).unknown(false);

// function validateTransaction(action) {
//   return function (req, res, next) {
//     const body = req.body || {};
//     const funds = body.funds;
//     const destination = body.destination;

//     const actionTx = inferActionIfMissing(body.action, funds, destination);
//     const providerSelected = computeProviderSelected(actionTx, funds, destination);

//     // Plafond single transaction dynamique
//     let maxLimit = 10000000;
//     let currencyForMsg = "F CFA";

//     if (action === "initiate") {
//       try {
//         // ✅ IMPORTANT: priorité aux devises "source/sender" pour plafonds
//         const cur = resolveCurrencyForLimits(body);
//         currencyForMsg = cur || currencyForMsg;
//         maxLimit = getSingleTxLimit(providerSelected, cur || currencyForMsg);
//       } catch (e) {}
//     }

//     let schema;
//     if (action === "initiate" && initiateSchemas[providerSelected]) {
//       schema = initiateSchemas[providerSelected].keys({
//         amount: Joi.number().min(1).max(maxLimit).required(),
//         action: Joi.string().valid("send", "deposit", "withdraw").optional(),
//       });
//     } else if (action === "confirm") {
//       schema = confirmSchema;
//     } else if (action === "cancel") {
//       schema = cancelSchema;
//     }

//     if (!schema) {
//       logger.warn("[validateTransaction] Provider/action non supporté", {
//         providerSelected,
//         destination,
//         funds,
//         action,
//         ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
//       });
//       return res.status(400).json({
//         success: false,
//         error: "Provider ou action non supporté.",
//         details: [],
//       });
//     }

//     const { error, value } = schema.validate(body, {
//       abortEarly: false,
//       stripUnknown: true, // ✅ maintenant OK car on whitelist les champs meta
//       convert: true,
//     });

//     if (error) {
//       let details = error.details.map((d) => d.message);
//       details = details.map((msg) => {
//         if (/less than or equal to (\d+)/i.test(msg)) {
//           return msg.replace(/less than or equal to (\d+)/i, (m, p1) => `less than or equal to ${p1} ${currencyForMsg}`);
//         }
//         return msg;
//       });

//       logger.warn(`[validateTransaction][${providerSelected}] Validation failed (${action})`, {
//         details,
//         ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
//         email: value?.toEmail || null,
//       });

//       return res.status(400).json({
//         success: false,
//         error: "Données invalides",
//         details,
//       });
//     }

//     req.body = value;

//     req.body.action = inferActionIfMissing(req.body.action, req.body.funds, req.body.destination);
//     req.providerSelected = computeProviderSelected(req.body.action, req.body.funds, req.body.destination);
//     req.body.provider = req.body.provider || req.providerSelected;

//     // ---------------------------
//     // ✅ Compat / alias mapping
//     // ---------------------------

//     if (req.providerSelected === "paynoval") {
//       // securityQuestion -> question
//       if (!req.body.question && req.body.securityQuestion) {
//         req.body.question = req.body.securityQuestion;
//       }

//       // ✅ Si le front envoie destinationCountry, on le mappe vers country (requis microservice)
//       if (!req.body.country && req.body.destinationCountry) {
//         req.body.country = req.body.destinationCountry;
//       }

//       // fallback country depuis user si toujours vide (rare)
//       if (!req.body.country) {
//         req.body.country =
//           req.user?.selectedCountry ||
//           req.user?.country ||
//           req.user?.countryCode ||
//           "";
//       }

//       // ✅ On garde aussi le pays émetteur pour AML si utile
//       if (!req.body.senderCountry) {
//         req.body.senderCountry =
//           req.user?.selectedCountry ||
//           req.user?.country ||
//           req.user?.countryCode ||
//           "";
//       }
//     }

//     if (action === "confirm") {
//       if (!req.body.securityCode && req.body.code) {
//         req.body.securityCode = req.body.code;
//       }
//     }

//     // Vérification des flux autorisés (funds/destination/action)
//     if (action === "initiate") {
//       const match = allowedFlows.find(
//         (f) =>
//           f.funds === req.body.funds &&
//           f.destination === req.body.destination &&
//           (!f.action || f.action === req.body.action)
//       );

//       if (!match) {
//         logger.warn("[validateTransaction] Flux funds/destination non autorisé", {
//           funds: req.body.funds,
//           destination: req.body.destination,
//           action: req.body.action,
//           ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
//         });

//         return res.status(400).json({
//           success: false,
//           error: "Ce flux funds/destination n'est pas autorisé.",
//           details: [],
//         });
//       }

//       req.routedProvider = req.providerSelected;

//       // ----- Daily limit UX-friendly check -----
//       (async () => {
//         try {
//           const userId = req.user && req.user._id;
//           if (userId) {
//             // ✅ IMPORTANT: devise pour limites = currencySource/senderCurrencyCode en priorité
//             const cur = resolveCurrencyForLimits(req.body);
//             const dailyLimit = getDailyLimit(req.providerSelected, cur);

//             const stats = await getUserTransactionsStats(userId, req.providerSelected, cur);
//             const dailyTotal = (stats && stats.dailyTotal ? stats.dailyTotal : 0) + (req.body.amountSource ?? req.body.amount ?? 0);

//             if (dailyTotal > dailyLimit) {
//               logger.warn("[validateTransaction] Plafond journalier dépassé", {
//                 userId,
//                 providerSelected: req.providerSelected,
//                 currency: cur,
//                 try: req.body.amountSource ?? req.body.amount,
//                 already: stats?.dailyTotal,
//                 max: dailyLimit,
//               });

//               return res.status(403).json({
//                 success: false,
//                 error: "Dépasse le plafond journalier autorisé",
//                 details: [`Le plafond journalier autorisé est ${dailyLimit.toLocaleString("fr-FR")} ${cur}.`],
//               });
//             }
//           }

//           if (res.headersSent) return;
//           next();
//         } catch (e) {
//           logger.error("[validateTransaction] Erreur vérification daily limit", { err: e });
//           if (res.headersSent) return;
//           next();
//         }
//       })();
//       return;
//     }

//     next();
//   };
// }

// module.exports = validateTransaction;





// File: middlewares/validateTransaction.js
"use strict";

const Joi = require("joi");
const logger = require("../logger");
const allowedFlows = require("../tools/allowedFlows");
const { getSingleTxLimit, getDailyLimit } = require("../tools/amlLimits");
const { getUserTransactionsStats } = require("../services/aml"); // Doit exister

/**
 * ----------------------------------------------------------
 * computeProviderSelected(action, funds, destination)
 * - deposit  => providerSelected = funds
 * - withdraw => providerSelected = destination
 * - send     => providerSelected = destination
 *
 * Compat front:
 * - si action est manquant => on tente de déduire via allowedFlows
 * - sinon fallback "send"
 * ----------------------------------------------------------
 */
function computeProviderSelected(action, funds, destination) {
  const a = String(action || "").toLowerCase().trim();
  const f = String(funds || "").toLowerCase().trim();
  const d = String(destination || "").toLowerCase().trim();

  if (a === "deposit") return f;
  if (a === "withdraw") return d;
  if (a === "send") return d;

  const candidates = allowedFlows.filter((x) => x.funds === f && x.destination === d);
  if (candidates.length === 1 && candidates[0].action) {
    const inferredAction = String(candidates[0].action).toLowerCase().trim();
    if (inferredAction === "deposit") return f;
    return d;
  }

  return d; // fallback send
}

function inferActionIfMissing(action, funds, destination) {
  const a = String(action || "").toLowerCase().trim();
  if (a === "send" || a === "deposit" || a === "withdraw") return a;

  const f = String(funds || "").toLowerCase().trim();
  const d = String(destination || "").toLowerCase().trim();

  const candidates = allowedFlows.filter((x) => x.funds === f && x.destination === d);
  if (candidates.length === 1 && candidates[0].action) {
    const inferred = String(candidates[0].action).toLowerCase().trim();
    if (inferred === "send" || inferred === "deposit" || inferred === "withdraw") return inferred;
  }

  return "send";
}

const PROVIDERS = [
  "paynoval",
  "stripe",
  "bank",
  "mobilemoney",
  "visa_direct",
  "stripe2momo",
  "flutterwave",
];

/**
 * ✅ Champs "meta" qu'on DOIT garder (sinon stripUnknown les supprime)
 */
const txMetaSchema = {
  // Montants source/target + fees
  amountSource: Joi.number().min(0).optional(),
  amountTarget: Joi.number().min(0).optional(),
  feeSource: Joi.number().min(0).optional(),
  feeTarget: Joi.number().min(0).optional(),

  // FX
  exchangeRate: Joi.number().min(0).optional(),
  fxRate: Joi.number().min(0).optional(),
  fxRateSourceToTarget: Joi.number().min(0).optional(),

  // Devise ISO / symboles
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

  // Pays (destination vs sender)
  country: Joi.string().max(64).optional(),
  destinationCountry: Joi.string().max(64).optional(),
  senderCountry: Joi.string().max(64).optional(),
  originCountry: Joi.string().max(64).optional(),
  fromCountry: Joi.string().max(64).optional(),
  countryTarget: Joi.string().max(64).optional(),

  // Frais côté app
  transactionFees: Joi.number().min(0).optional(),

  // Divers compat front
  recipientInfo: Joi.object().unknown(true).optional(),
  toName: Joi.string().max(128).optional(),
  toBank: Joi.string().max(128).optional(),
  recipientName: Joi.string().max(128).optional(),
};

const baseSchema = {
  funds: Joi.string().valid(...PROVIDERS).required(),
  destination: Joi.string().valid(...PROVIDERS).required(),

  amount: Joi.number().min(1).required(),

  provider: Joi.string().optional(),
  action: Joi.string().valid("send", "deposit", "withdraw").optional(),

  // ✅ garder les meta partout (sinon stripUnknown les supprime)
  ...txMetaSchema,
};

// ✅ Résout la devise pour les limites AML (priorité "source/sender")
function resolveCurrencyForLimits(body = {}) {
  const cand =
    body.currencySource ||
    body.senderCurrencyCode ||
    body.currencyCode ||
    body.currencySender ||
    body.currency ||
    body.selectedCurrency ||
    "";
  return cand || "USD";
}

// ✅ Essaie de récupérer un "country destination" depuis différents alias
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

const initiateSchemas = {
  paynoval: Joi.object({
    ...baseSchema,
    toEmail: Joi.string().email().required(),
    message: Joi.string().max(256).optional(),

    // microservice paynoval exige question + securityCode
    question: Joi.string().max(128).required(),
    securityQuestion: Joi.string().max(128).optional(),

    securityCode: Joi.string().max(32).required(),

    /**
     * ⚠️ IMPORTANT:
     * on exige "country" pour le microservice,
     * mais on va le pré-remplir via alias AVANT Joi si le front envoie destinationCountry
     */
    country: Joi.string().max(64).required(),
  }),

  stripe: Joi.object({
    ...baseSchema,
    currency: Joi.string().length(3).uppercase().required(),
    cardNumber: Joi.string().creditCard().required(),
    expMonth: Joi.number().min(1).max(12).required(),
    expYear: Joi.number()
      .min(new Date().getFullYear())
      .max(new Date().getFullYear() + 20)
      .required(),
    cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
    cardHolder: Joi.string().max(64).required(),
    toEmail: Joi.string().email().optional(),
  }),

  mobilemoney: Joi.object({
    ...baseSchema,
    phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
    operator: Joi.string().valid("orange", "mtn", "moov", "wave").required(),
    recipientName: Joi.string().max(64).optional(),
    country: Joi.string().max(64).required(),
  }),

  bank: Joi.object({
    ...baseSchema,
    iban: Joi.string().pattern(/^[A-Z0-9]{15,34}$/).required(),
    bankName: Joi.string().max(128).required(),
    accountHolder: Joi.string().max(128).required(),
    country: Joi.string().max(64).required(),
    swift: Joi.string().pattern(/^[A-Z0-9]{8,11}$/).optional(),
  }),

  visa_direct: Joi.object({
    ...baseSchema,
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

  stripe2momo: Joi.object({
    ...baseSchema,
    phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
    operator: Joi.string().valid("orange", "mtn", "moov", "wave").required(),
    country: Joi.string().max(64).required(),
    stripeRef: Joi.string().max(128).optional(),
  }),

  flutterwave: Joi.object({
    ...baseSchema,
    currency: Joi.string().length(3).uppercase().required(),
    phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
    operator: Joi.string().max(64).optional(),
    recipientName: Joi.string().max(128).optional(),
    country: Joi.string().max(64).required(),
    bankCode: Joi.string().max(32).optional(),
    accountNumber: Joi.string().max(32).optional(),
  }),
};

const confirmSchema = Joi.object({
  provider: Joi.string().valid(...PROVIDERS).required(),
  transactionId: Joi.string().required(),

  securityCode: Joi.string().max(32).allow("").optional(),
  code: Joi.string().max(32).allow("").optional(),

  reference: Joi.string().max(128).optional(),
}).unknown(false);

const cancelSchema = Joi.object({
  provider: Joi.string().valid(...PROVIDERS).required(),
  transactionId: Joi.string().required(),
}).unknown(false);

function validateTransaction(action) {
  return function (req, res, next) {
    const body = req.body || {};
    const funds = body.funds;
    const destination = body.destination;

    const actionTx = inferActionIfMissing(body.action, funds, destination);
    const providerSelected = computeProviderSelected(actionTx, funds, destination);

    // ----------------------------------------------------
    // ✅ PRE-MAP compat AVANT Joi (sinon stripUnknown supprime)
    // ----------------------------------------------------
    if (action === "initiate" && providerSelected === "paynoval") {
      // question compat
      if (!body.question && body.securityQuestion) body.question = body.securityQuestion;

      // ✅ Fix principal: si front envoie destinationCountry/countryTarget/etc.
      if (!body.country) {
        body.country = resolveCountryCompat(body, req.user || {});
      }

      // (optionnel) garder senderCountry pour AML si tu veux
      if (!body.senderCountry) {
        body.senderCountry =
          req.user?.selectedCountry || req.user?.country || req.user?.countryCode || "";
      }
    }

    // ----------------------------------------------------
    // Plafond single transaction dynamique
    // ----------------------------------------------------
    let maxLimit = 10000000;
    let currencyForMsg = "F CFA";

    if (action === "initiate") {
      try {
        const cur = resolveCurrencyForLimits(body);
        currencyForMsg = cur || currencyForMsg;
        maxLimit = getSingleTxLimit(providerSelected, cur || currencyForMsg);
      } catch (e) {}
    }

    let schema;
    if (action === "initiate" && initiateSchemas[providerSelected]) {
      schema = initiateSchemas[providerSelected].keys({
        amount: Joi.number().min(1).max(maxLimit).required(),
        action: Joi.string().valid("send", "deposit", "withdraw").optional(),
      });
    } else if (action === "confirm") {
      schema = confirmSchema;
    } else if (action === "cancel") {
      schema = cancelSchema;
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
          return msg.replace(/less than or equal to (\d+)/i, (m, p1) => `less than or equal to ${p1} ${currencyForMsg}`);
        }
        return msg;
      });

      logger.warn(`[validateTransaction][${providerSelected}] Validation failed (${action})`, {
        details,
        ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
        email: value?.toEmail || null,
      });

      return res.status(400).json({
        success: false,
        error: "Données invalides",
        details,
      });
    }

    req.body = value;

    req.body.action = inferActionIfMissing(req.body.action, req.body.funds, req.body.destination);
    req.providerSelected = computeProviderSelected(req.body.action, req.body.funds, req.body.destination);
    req.body.provider = req.body.provider || req.providerSelected;

    // ---------------------------
    // ✅ Compat / alias mapping (post-validate)
    // ---------------------------
    if (req.providerSelected === "paynoval") {
      if (!req.body.question && req.body.securityQuestion) {
        req.body.question = req.body.securityQuestion;
      }

      // double sécurité: si jamais country vide (devrait plus arriver)
      if (!req.body.country) {
        req.body.country = resolveCountryCompat(req.body, req.user || {});
      }
    }

    if (action === "confirm") {
      if (!req.body.securityCode && req.body.code) {
        req.body.securityCode = req.body.code;
      }
    }

    // Vérification des flux autorisés (funds/destination/action)
    if (action === "initiate") {
      const match = allowedFlows.find(
        (f) =>
          f.funds === req.body.funds &&
          f.destination === req.body.destination &&
          (!f.action || f.action === req.body.action)
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

      // ----- Daily limit UX-friendly check -----
      (async () => {
        try {
          const userId = req.user && req.user._id;
          if (userId) {
            const cur = resolveCurrencyForLimits(req.body);
            const dailyLimit = getDailyLimit(req.providerSelected, cur);

            const stats = await getUserTransactionsStats(userId, req.providerSelected, cur);
            const inc = req.body.amountSource ?? req.body.amount ?? 0;
            const dailyTotal = (stats && stats.dailyTotal ? stats.dailyTotal : 0) + inc;

            if (dailyTotal > dailyLimit) {
              logger.warn("[validateTransaction] Plafond journalier dépassé", {
                userId,
                providerSelected: req.providerSelected,
                currency: cur,
                try: inc,
                already: stats?.dailyTotal,
                max: dailyLimit,
              });

              return res.status(403).json({
                success: false,
                error: "Dépasse le plafond journalier autorisé",
                details: [`Le plafond journalier autorisé est ${dailyLimit.toLocaleString("fr-FR")} ${cur}.`],
              });
            }
          }

          if (res.headersSent) return;
          next();
        } catch (e) {
          logger.error("[validateTransaction] Erreur vérification daily limit", { err: e });
          if (res.headersSent) return;
          next();
        }
      })();
      return;
    }

    next();
  };
}

module.exports = validateTransaction;
