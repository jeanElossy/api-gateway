// File: middlewares/validateTransaction.js

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

  // action inconnue -> si flow unique dans allowedFlows on prend son action
  const candidates = allowedFlows.filter((x) => x.funds === f && x.destination === d);
  if (candidates.length === 1 && candidates[0].action) {
    const inferredAction = String(candidates[0].action).toLowerCase().trim();
    if (inferredAction === "deposit") return f;
    return d; // send/withdraw
  }

  // fallback send
  return d;
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

const baseSchema = {
  funds: Joi.string().valid(...PROVIDERS).required(),
  destination: Joi.string().valid(...PROVIDERS).required(),
  amount: Joi.number().min(1).required(),

  // provider est optionnel côté front, nous on va le normaliser avec providerSelected
  provider: Joi.string().optional(),

  // action peut être optionnel pour compat front
  action: Joi.string().valid("send", "deposit", "withdraw").optional(),
};

const initiateSchemas = {
  paynoval: Joi.object({
    ...baseSchema,
    toEmail: Joi.string().email().required(),
    message: Joi.string().max(256).optional(),

    // ✅ IMPORTANT: microservice paynoval exige question + securityCode
    // Compat: certains fronts envoyaient "securityQuestion"
    question: Joi.string().max(128).required(),
    securityQuestion: Joi.string().max(128).optional(),

    // ✅ IMPORTANT: microservice exige securityCode
    securityCode: Joi.string().max(32).required(),

    // ✅ IMPORTANT: microservice exige country dans ses checks
    country: Joi.string().max(32).required(),

    recipientInfo: Joi.object().unknown(true).optional(),
    exchangeRate: Joi.number().min(0).optional(),
    transactionFees: Joi.number().min(0).optional(),
    localAmount: Joi.number().min(0).optional(),
    localCurrencySymbol: Joi.string().max(8).optional(),
    senderCurrencySymbol: Joi.string().max(8).optional(),
    selectedCurrency: Joi.string().max(8).optional(),
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

    // compat: certains flows mettaient toEmail même si c'est un dépôt
    toEmail: Joi.string().email().optional(),
  }),

  mobilemoney: Joi.object({
    ...baseSchema,
    phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
    operator: Joi.string().valid("orange", "mtn", "moov", "wave").required(),
    recipientName: Joi.string().max(64).optional(),
    country: Joi.string().max(32).required(),
  }),

  bank: Joi.object({
    ...baseSchema,
    iban: Joi.string().pattern(/^[A-Z0-9]{15,34}$/).required(),
    bankName: Joi.string().max(128).required(),
    accountHolder: Joi.string().max(128).required(),
    country: Joi.string().max(32).required(),
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
    country: Joi.string().max(32).optional(),
  }),

  stripe2momo: Joi.object({
    ...baseSchema,
    phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
    operator: Joi.string().valid("orange", "mtn", "moov", "wave").required(),
    country: Joi.string().max(32).required(),
    stripeRef: Joi.string().max(128).optional(),
  }),

  flutterwave: Joi.object({
    ...baseSchema,
    currency: Joi.string().length(3).uppercase().required(),
    phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
    operator: Joi.string().max(64).optional(),
    recipientName: Joi.string().max(128).optional(),
    country: Joi.string().max(32).required(),
    bankCode: Joi.string().max(32).optional(),
    accountNumber: Joi.string().max(32).optional(),
  }),
};

const confirmSchema = Joi.object({
  provider: Joi.string().valid(...PROVIDERS).required(),
  transactionId: Joi.string().required(),

  // ✅ compat: certains fronts envoient "code", microservice attend "securityCode"
  securityCode: Joi.string().max(32).allow("").optional(),
  code: Joi.string().max(32).allow("").optional(),

  // optionnel au cas où (certains providers confirment par ref)
  reference: Joi.string().max(128).optional(),
});

const cancelSchema = Joi.object({
  provider: Joi.string().valid(...PROVIDERS).required(),
  transactionId: Joi.string().required(),
});

function validateTransaction(action) {
  return function (req, res, next) {
    const body = req.body || {};
    const funds = body.funds;
    const destination = body.destination;

    // ✅ action compat: si pas fourni
    const actionTx = inferActionIfMissing(body.action, funds, destination);
    const providerSelected = computeProviderSelected(actionTx, funds, destination);

    // Plafond single transaction dynamique
    let maxLimit = 10000000;
    let currency = "F CFA";

    if (action === "initiate") {
      try {
        currency = body.selectedCurrency || body.currencySender || body.currency || "F CFA";
        maxLimit = getSingleTxLimit(providerSelected, currency);
      } catch (e) {}
    }

    // Préparation du schéma dynamique
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

    // ✅ validate + normalise req.body avec value (stripUnknown/convert)
    const { error, value } = schema.validate(body, {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      let details = error.details.map((d) => d.message);
      details = details.map((msg) => {
        if (/less than or equal to (\d+)/i.test(msg)) {
          return msg.replace(/less than or equal to (\d+)/i, (m, p1) => `less than or equal to ${p1} ${currency}`);
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

    // ✅ apply normalized body back
    req.body = value;

    // ✅ On force action normalisée si manquante (compat)
    req.body.action = inferActionIfMissing(req.body.action, req.body.funds, req.body.destination);

    // ✅ providerSelected (routing)
    req.providerSelected = computeProviderSelected(req.body.action, req.body.funds, req.body.destination);

    // ✅ harmonise provider
    req.body.provider = req.body.provider || req.providerSelected;

    // ---------------------------
    // ✅ Compat / alias mapping
    // ---------------------------

    // ✅ Paynoval: securityQuestion -> question
    if (req.providerSelected === "paynoval") {
      if (!req.body.question && req.body.securityQuestion) {
        req.body.question = req.body.securityQuestion;
      }

      // ✅ Fallback country depuis user si front ne l'envoie pas (mais schema le requiert)
      // (utile si un jour tu assouplis le schema, et évite des 400 inutiles)
      if (!req.body.country) {
        req.body.country =
          req.user?.selectedCountry ||
          req.user?.country ||
          req.user?.countryCode ||
          "";
      }
    }

    // ✅ Confirm: code -> securityCode
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

      // ✅ important: le controller doit router vers providerSelected (pas destination)
      req.routedProvider = req.providerSelected;

      // ----- Daily limit UX-friendly check -----
      (async () => {
        try {
          const userId = req.user && req.user._id;
          if (userId) {
            currency =
              req.body.selectedCurrency ||
              req.body.currencySender ||
              req.body.currency ||
              "F CFA";

            const dailyLimit = getDailyLimit(req.providerSelected, currency);
            const stats = await getUserTransactionsStats(userId, req.providerSelected, currency);
            const dailyTotal =
              (stats && stats.dailyTotal ? stats.dailyTotal : 0) +
              (req.body.amount || 0);

            if (dailyTotal > dailyLimit) {
              logger.warn("[validateTransaction] Plafond journalier dépassé", {
                userId,
                providerSelected: req.providerSelected,
                currency,
                try: req.body.amount,
                already: stats?.dailyTotal,
                max: dailyLimit,
              });

              // ✅ évite d'appeler next() après avoir répondu
              return res.status(403).json({
                success: false,
                error: "Dépasse le plafond journalier autorisé",
                details: [`Le plafond journalier autorisé est ${dailyLimit.toLocaleString("fr-FR")} ${currency}.`],
              });
            }
          }

          // ✅ si la réponse a déjà été envoyée, ne pas next()
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
