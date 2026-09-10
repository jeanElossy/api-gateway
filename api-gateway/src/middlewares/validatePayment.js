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
  // `currency` était ABSENTE de ce schéma. Avec `stripUnknown: true`, une devise
  // envoyée par le client était silencieusement retirée, et Tx-Core recevait un
  // encaissement sans devise. Le même défaut avait déjà été trouvé sur le rail
  // carte le 2026-09-08 : deux schémas voisins, la même omission.
  currency: Joi.string().min(3).max(4).uppercase().required(),
  phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
  operator: Joi.string().valid('orange', 'mtn', 'moov', 'wave').required(),
  recipientName: Joi.string().max(64).optional(),
  country: Joi.string().max(32).required(),
});


/**
 * ============================================================================
 * RAIL CARTE — UN JETON, PAS UN NUMÉRO
 * ============================================================================
 *
 * Ce schéma EXIGEAIT `cardNumber`, `cvc`, `expMonth` et `expYear`. Autrement
 * dit, la validation d'entrée de la passerelle REFUSAIT tout paiement par carte
 * qui n'aurait PAS porté le numéro en clair. Le périmètre PCI-DSS n'était pas
 * seulement ouvert : il était obligatoire.
 *
 * Il exige désormais l'inverse : un jeton opaque, émis par le prestataire
 * depuis le navigateur du payeur. C'est le modèle Stripe Elements / Adyen
 * Components / Checkout.com Frames — la carte ne touche jamais nos serveurs, et
 * l'attestation applicable reste SAQ A.
 *
 * ⚠️ Aucun champ de carte n'est déclaré ici, même pour être refusé. Ce schéma
 * s'exécute avec `stripUnknown: true` : un champ non déclaré est RETIRÉ du
 * corps, en silence, sans erreur ni journal. Déclarer `cardNumber` pour le
 * rejeter ici serait donc redondant, et l'y OUBLIER serait invisible.
 *
 * Le refus est porté en amont par `refuseRawCardData`, monté AVANT ce
 * middleware dans `routes/payment.js` — c'est le seul étage qui voit encore le
 * corps brut. L'ordre des deux est un invariant, verrouillé par
 * `test/security/noRawCardData.test.js`.
 */
const visaDirectSchema = Joi.object({
  ...commonMetaFields,
  provider: Joi.string().valid('visa_direct').required(),
  amount: Joi.number().min(1).required(),
  currency: Joi.string().length(3).uppercase().required(),

  /**
   * Jeton opaque du prestataire. Sa forme lui appartient — on n'en valide que
   * la présence et une longueur plafonnée. Y imposer un motif reviendrait à
   * coder en dur le format d'un partenaire qui n'est pas encore choisi.
   */
  cardToken: Joi.string().min(8).max(512).required(),

  cardHolder: Joi.string().max(64).optional(),
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
