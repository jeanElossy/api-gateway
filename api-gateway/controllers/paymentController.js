const axios = require('axios');
const config = require('../src/config');
const logger = require('../src/logger');

function cleanSensitiveMeta(meta) {
  const clone = { ...meta };
  if (clone.cardNumber) clone.cardNumber = '****' + clone.cardNumber.slice(-4);
  if (clone.cvc) delete clone.cvc;
  if (clone.securityCode) delete clone.securityCode;
  return clone;
}

const PROVIDER_TO_ENDPOINT = {
  paynoval:    `${config.microservices.paynoval}/pay`,
  stripe:      `${config.microservices.stripe}/pay`,
  bank:        `${config.microservices.bank}/pay`,
  mobilemoney: `${config.microservices.mobilemoney}/pay`,
  visa_direct: config.microservices.visa_direct ? `${config.microservices.visa_direct}/pay` : undefined,
  stripe2momo: config.microservices.orchestrator ? `${config.microservices.orchestrator}/stripe2momo` : undefined,
};

function resolveProviderKey(body) {
  if (body.provider && PROVIDER_TO_ENDPOINT[body.provider]) return body.provider;
  if (body.destination && PROVIDER_TO_ENDPOINT[body.destination]) return body.destination;
  return null;
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
    logger.info(`[PAYMENT→${providerKey}] Paiement réussi`, {
      provider: providerKey,
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
