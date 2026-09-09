// middlewares/validatePayment.js

const Joi = require('joi');
const logger = require('../logger');

// 🧩 Champs communs pour le contexte "cagnotte"
const commonMetaFields = {
  // Permet de taguer le paiement comme étant lié à une cagnotte
  context: Joi.string().valid('cagnotte').optional(),

  // ID MongoDB de la cagnotte (utilisé par le Gateway pour le callback)
  cagnotteId: Joi.string().hex().length(24).optional(),

  // Code de participation (PN-XXXXXX) si tu veux aussi le passer
  cagnotteCode: Joi.string().max(64).optional(),

  // Nom du contributeur pour l’affichage dans la cagnotte
  donorName: Joi.string().max(128).optional(),
};

// Schémas de validation par provider
const paynovalPaymentSchema = Joi.object({
  ...commonMetaFields,
  provider: Joi.string().valid('paynoval').required(),
  toEmail: Joi.string().email().required(),
  amount: Joi.number().min(1).required(),
  question: Joi.string().max(128).allow('').optional(),
  funds: Joi.string().max(64).optional(),
  country: Joi.string().max(64).optional(),
  destination: Joi.string().max(128).optional(),
  recipientInfo: Joi.object().unknown(true).optional(),
  exchangeRate: Joi.number().min(0).optional(),
  transactionFees: Joi.number().min(0).optional(),
  localAmount: Joi.number().min(0).optional(),
  localCurrencySymbol: Joi.string().max(8).optional(),
  senderCurrencySymbol: Joi.string().max(8).optional(),
  selectedCurrency: Joi.string().max(8).optional(),
  securityCode: Joi.string().max(32).allow('').optional(),
});


const mobileMoneyPaymentSchema = Joi.object({
  ...commonMetaFields,
  provider: Joi.string().valid('mobilemoney').required(),
  amount: Joi.number().min(1).required(),
  phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
  operator: Joi.string().valid('orange', 'mtn', 'moov', 'wave').required(),
  recipientName: Joi.string().max(64).optional(),
  country: Joi.string().max(32).required(),
});


const visaDirectSchema = Joi.object({
  ...commonMetaFields,
  provider: Joi.string().valid('visa_direct').required(),
  amount: Joi.number().min(1).required(),
  // `currency` manquait ici alors que le rail carte remplace `stripe`, qui
  // l'exigeait. Avec `stripUnknown: true`, l'absence de la clé ne produisait
  // aucune erreur : la devise était SILENCIEUSEMENT supprimée du corps avant
  // routage. Une devise perdue sur un chemin d'argent n'est pas un détail.
  currency: Joi.string().length(3).uppercase().required(),
  cardNumber: Joi.string().creditCard().required(),
  expMonth: Joi.number().min(1).max(12).required(),
  expYear: Joi.number().min(new Date().getFullYear()).max(new Date().getFullYear() + 20).required(),
  cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
  cardHolder: Joi.string().max(64).required(),
  toEmail: Joi.string().email().optional(),
  country: Joi.string().max(32).optional(),
});



/**
 * Les rails servis par `POST /api/v1/pay`. Périmètre arrêté le 2026-09-08.
 *
 * Quatre schémas ont été retirés : `stripe`, `bank`, `stripe2momo` et
 * `flutterwave`. Les trois premiers sont hors périmètre produit ; `flutterwave`
 * n'est pas un rail mais un OPÉRATEUR du rail mobile money, et lui laisser une
 * entrée propre créait un second chemin vers le même argent, échappant aux
 * plafonds du rail `mobilemoney`.
 *
 * ⚠️ Le schéma retiré `stripe2momo` acceptait un numéro de carte ET un numéro
 * de téléphone dans la MÊME requête : un pont carte → mobile money en un appel,
 * sans étape intermédiaire au grand livre.
 */
const SCHEMAS = {
  paynoval: paynovalPaymentSchema,
  mobilemoney: mobileMoneyPaymentSchema,
  visa_direct: visaDirectSchema,
};

// Détection du bon schéma selon body.provider ou body.destination
function getProviderKey(body) {
  if (body.provider && SCHEMAS[body.provider]) return body.provider;
  if (body.destination && SCHEMAS[body.destination]) return body.destination;
  return null;
}

function validatePayment(req, res, next) {
  const providerKey = getProviderKey(req.body);
  if (!providerKey) {
    logger.warn('[validatePayment] Provider non supporté', {
      provider: req.body.provider,
      destination: req.body.destination,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    });
    return res.status(400).json({
      success: false,
      error: 'Provider non supporté.',
      details: [req.body.provider || req.body.destination || 'aucun'],
    });
  }
  const schema = SCHEMAS[providerKey];
  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    logger.warn(`[validatePayment][${providerKey}] Validation failed`, {
      details: error.details.map(d => d.message),
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      email: req.body.toEmail || null,
    });
    return res.status(400).json({
      success: false,
      error: 'Données invalides',
      details: error.details.map(d => d.message),
    });
  }

  // On remplace le body par la version "clean" validée (sans unknown)
  req.body = value;

  // Pour usage ultérieur dans les controllers (routing cible dynamique)
  req.routedProvider = providerKey;
  next();
}

module.exports = validatePayment;
