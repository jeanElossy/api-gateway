// controllers/paymentController.js

const axios = require('axios');
const config = require('../src/config');
const logger = require('../src/logger');

// Masque les champs sensibles pour les logs
function cleanSensitiveMeta(meta) {
  const clone = { ...meta };
  if (clone.cardNumber) clone.cardNumber = '****' + clone.cardNumber.slice(-4);
  if (clone.cvc) delete clone.cvc;
  if (clone.securityCode) delete clone.securityCode;
  return clone;
}

// Mapping provider → endpoint cible
const PROVIDER_TO_ENDPOINT = {
  paynoval:    `${config.microservices.paynoval}/pay`,
  stripe:      `${config.microservices.stripe}/pay`,
  bank:        `${config.microservices.bank}/pay`,
  mobilemoney: `${config.microservices.mobilemoney}/pay`,
  visa_direct: config.microservices.visaDirect ? `${config.microservices.visaDirect}/pay` : undefined,
  stripe2momo: config.microservices.orchestrator ? `${config.microservices.orchestrator}/stripe2momo` : undefined,
};

exports.handlePayment = async (req, res) => {
  const { provider } = req.body;
  const targetUrl = PROVIDER_TO_ENDPOINT[provider];

  if (!targetUrl) {
    logger.error(`[PAYMENT] Provider non supporté demandé`, {
      provider,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    });
    return res.status(400).json({ error: 'Provider non supporté.' });
  }

  try {
    const response = await axios.post(
      targetUrl,
      cleanSensitiveMeta(req.body),
      {
        headers: {
          'Authorization': req.headers.authorization,
          'x-internal-token': config.internalToken,
        },
        timeout: 15000,
      }
    );
    logger.info(`[PAYMENT→${provider}] Paiement réussi`, {
      provider,
      amount: req.body.amount,
      to: req.body.toEmail || req.body.phoneNumber || req.body.iban || req.body.cardNumber,
      status: response.status,
      user: req.user?.email || null,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      ref: response.data?.reference || response.data?.id || null,
    });
    return res.status(response.status).json(response.data);

  } catch (err) {
    if (err.response) {
      logger.error(`[PAYMENT→${provider}] Échec API`, {
        provider,
        status: err.response.status,
        data: err.response.data,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      });
      return res.status(err.response.status).json({
        error: err.response.data?.error || `Erreur interne ${provider}`
      });
    } else {
      logger.error(`[PAYMENT→${provider}] Axios error: ${err.message}`, {
        provider,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      });
      return res.status(502).json({ error: `Service ${provider} temporairement indisponible.` });
    }
  }
};
