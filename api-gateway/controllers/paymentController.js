// controllers/paymentController.js

const axios = require('axios');
const config = require('../src/config');
const logger = require('../src/logger');

/**
 * Nettoie les champs sensibles avant de forward vers les microservices
 * (on évite de logger/propager le numéro de carte brut, CVC, etc.)
 */
function cleanSensitiveMeta(meta) {
  const clone = { ...meta };
  if (clone.cardNumber) clone.cardNumber = '****' + clone.cardNumber.slice(-4);
  if (clone.cvc) delete clone.cvc;
  if (clone.securityCode) delete clone.securityCode;
  return clone;
}

// Mapping provider → URL du microservice de paiement
const PROVIDER_TO_ENDPOINT = {
  paynoval:    `${config.microservices.paynoval}/pay`,
  stripe:      `${config.microservices.stripe}/pay`,
  bank:        `${config.microservices.bank}/pay`,
  mobilemoney: `${config.microservices.mobilemoney}/pay`,
  visa_direct: config.microservices.visa_direct ? `${config.microservices.visa_direct}/pay` : undefined,
  stripe2momo: config.microservices.stripe2momo ? `${config.microservices.stripe2momo}/pay` : undefined,
  flutterwave: config.microservices.flutterwave ? `${config.microservices.flutterwave}/pay` : undefined,
};

/**
 * Headers d’audit envoyés vers les microservices
 * (auth, user, session, etc.)
 */
function auditHeaders(req) {
  return {
    'Authorization': req.headers.authorization,
    'x-internal-token': config.internalToken,
    'x-request-id': req.headers['x-request-id'] || require('crypto').randomUUID(),
    'x-user-id': req.user?._id || req.headers['x-user-id'] || '',
    'x-session-id': req.headers['x-session-id'] || '',
  };
}

/**
 * Détection du provider à partir du body
 */
function resolveProviderKey(body) {
  if (body.provider && PROVIDER_TO_ENDPOINT[body.provider]) return body.provider;
  if (body.destination && PROVIDER_TO_ENDPOINT[body.destination]) return body.destination;
  return null;
}

/**
 * 🔗 URL de base du backend qui gère les cagnottes
 *
 * 👉 À configurer dans ton config :
 *    - soit config.microservices.cagnottes
 *    - soit, par défaut, on retombe sur ton backend "paynoval"
 */
function getCagnottesBaseUrl() {
  const base =
    config.microservices.cagnottes ||
    config.microservices.paynoval ||
    '';
  return base.replace(/\/+$/, '');
}

/**
 * 🧩 Side-effect : informer le backend Cagnottes qu’un paiement
 * externe pour une cagnotte a été confirmé côté Gateway.
 *
 * 👉 Appelle la route :
 *    POST /api/v1/cagnottes/:id/external-payment-callback
 *
 * ⚠️ IMPORTANT :
 *  - Protégé par un token partagé CAGNOTTE_GATEWAY_TOKEN
 *  - On ne bloque PAS la réponse client si ça échoue
 */
async function notifyCagnotteExternalContribution(req, providerKey, providerResponse) {
  const { context, cagnotteId, cagnotteCode, donorName } = req.body || {};

  // Si ce paiement n’est PAS lié à une cagnotte → on sort
  if (context !== 'cagnotte' || !cagnotteId) {
    return;
  }

  const baseUrl = getCagnottesBaseUrl();
  if (!baseUrl) {
    logger.warn('[PAYMENT→CAGNOTTE] URL backend cagnottes non configurée (config.microservices.cagnottes ou paynoval)');
    return;
  }

  const url = `${baseUrl}/api/v1/cagnottes/${cagnotteId}/external-payment-callback`;

  const amount = Number(req.body.amount) || 0;
  if (!amount || amount <= 0) {
    logger.warn('[PAYMENT→CAGNOTTE] Montant invalide pour cagnotte', {
      cagnotteId,
      amount: req.body.amount,
    });
    return;
  }

  // Nom du contributeur : on prend en priorité donorName, sinon un fallback
  const nom =
    donorName ||
    req.body.recipientName ||
    req.user?.fullName ||
    'Contributeur externe';

  // Référence externe renvoyée par le microservice de paiement
  const externalRef =
    providerResponse?.data?.reference ||
    providerResponse?.data?.id ||
    null;

  const payload = {
    amount,
    nom,
    status: 'succeeded', // ici on part du principe que si on est là, le paiement est OK
    provider: providerKey,
    externalRef,
    // Petit bonus : on peut envoyer le code de participation si tu veux t’en servir
    codeParticipation: cagnotteCode || req.body.codeParticipation || undefined,
  };

  try {
    await axios.post(
      url,
      payload,
      {
        timeout: 8000,
        headers: {
          // 🔐 Token partagé entre Gateway et backend cagnottes
          'x-gateway-token': process.env.CAGNOTTE_GATEWAY_TOKEN || '',
        },
      }
    );
    logger.info('[PAYMENT→CAGNOTTE] Participation externe notifiée', {
      cagnotteId,
      amount,
      provider: providerKey,
      externalRef,
    });
  } catch (err) {
    logger.error('[PAYMENT→CAGNOTTE] Échec callback externe', {
      cagnotteId,
      provider: providerKey,
      error: err.response?.data || err.message,
    });
    // On NE jette PAS l’erreur : la réponse au client doit rester OK
  }
}

exports.handlePayment = async (req, res) => {
  const providerKey = resolveProviderKey(req.body);
  const targetUrl = providerKey ? PROVIDER_TO_ENDPOINT[providerKey] : null;

  if (!targetUrl) {
    logger.error(`[PAYMENT] Provider non supporté demandé`, {
      provider: req.body.provider,
      destination: req.body.destination,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    });
    return res.status(400).json({ error: 'Provider non supporté.' });
  }

  try {
    // 1️⃣ On envoie la requête vers le microservice de paiement
    const response = await axios.post(
      targetUrl,
      cleanSensitiveMeta(req.body),
      {
        headers: auditHeaders(req),
        timeout: 15000,
      }
    );

    logger.info(`[PAYMENT→${providerKey}] Paiement réussi`, {
      provider: providerKey,
      amount: req.body.amount,
      to: req.body.toEmail || req.body.phoneNumber || req.body.iban || req.body.cardNumber,
      status: response.status,
      user: req.user?.email || null,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      ref: response.data?.reference || response.data?.id || null,
    });

    // 2️⃣ SI ce paiement est lié à une cagnotte → on notifie le backend Cagnottes
    //    (flot "gens SANS compte PayNoval" ou paiement externe pour une cagnotte)
    try {
      await notifyCagnotteExternalContribution(req, providerKey, response);
    } catch (err) {
      // hyper défensif : on log mais on ne bloque PAS la réponse au client
      logger.error('[PAYMENT] Erreur side-effect cagnotte', {
        provider: providerKey,
        error: err.message,
      });
    }

    // 3️⃣ Réponse normale au client
    return res.status(response.status).json(response.data);

  } catch (err) {
    if (err.response) {
      logger.error(`[PAYMENT→${providerKey}] Échec API`, {
        provider: providerKey,
        status: err.response.status,
        data: err.response.data,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      });
      return res.status(err.response.status).json({
        error: err.response.data?.error || `Erreur interne ${providerKey}`
      });
    } else {
      logger.error(`[PAYMENT→${providerKey}] Axios error: ${err.message}`, {
        provider: providerKey,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      });
      return res.status(502).json({ error: `Service ${providerKey} temporairement indisponible.` });
    }
  }
};
