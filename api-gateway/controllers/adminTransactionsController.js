const axios = require('axios');
const config = require('../config'); // adapte si besoin
const logger = require('../logger');

// --- Centralise tous tes services micro frontaux
const PROVIDER_TO_SERVICE = {
  paynoval:     config.microservices.paynoval,
  stripe:       config.microservices.stripe,
  bank:         config.microservices.bank,
  mobilemoney:  config.microservices.mobilemoney,
  visa_direct:  config.microservices.visa_direct,
  visadirect:   config.microservices.visa_direct,
  cashin:       config.microservices.cashin,
  cashout:      config.microservices.cashout,
  stripe2momo:  config.microservices.stripe2momo,
  flutterwave:  config.microservices.flutterwave,
};

function getTargetService(req) {
  const provider = req.query.provider || req.body.provider || 'paynoval';
  return PROVIDER_TO_SERVICE[provider];
}

function auditHeaders(req) {
  return {
    'Authorization': req.headers.authorization,
    'x-internal-token': config.internalToken,
    'x-request-id': req.headers['x-request-id'] || require('crypto').randomUUID(),
    'x-user-id': req.user?._id || req.headers['x-user-id'] || '',
    'x-session-id': req.headers['x-session-id'] || '',
  };
}

// --- LIST
exports.listTransactions = async (req, res) => {
  const targetService = getTargetService(req);
  if (!targetService) return res.status(400).json({ success: false, error: 'Provider inconnu' });
  try {
    const response = await axios.get(`${targetService}/admin/transactions`, {
      headers: auditHeaders(req),
      params: req.query,
      timeout: 20000,
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error  = err.response?.data?.error || 'Erreur proxy LIST admin tx';
    logger.error('[Gateway][AdminTx] LIST:', { status, error });
    res.status(status).json({ success: false, error });
  }
};

// --- ONE
exports.getTransactionById = async (req, res) => {
  const targetService = getTargetService(req);
  if (!targetService) return res.status(400).json({ success: false, error: 'Provider inconnu' });
  try {
    const response = await axios.get(`${targetService}/admin/transactions/${req.params.id}`, {
      headers: auditHeaders(req),
      timeout: 10000,
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error  = err.response?.data?.error || 'Erreur proxy GET admin tx';
    logger.error('[Gateway][AdminTx] GET:', { status, error });
    res.status(status).json({ success: false, error });
  }
};

// --- VALIDATE
exports.validateTransaction = async (req, res) => {
  const targetService = getTargetService(req);
  if (!targetService) return res.status(400).json({ success: false, error: 'Provider inconnu' });
  try {
    const response = await axios.post(
      `${targetService}/admin/transactions/${req.params.id}/validate`,
      req.body,
      { headers: auditHeaders(req), timeout: 15000 }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error  = err.response?.data?.error || 'Erreur proxy VALIDATE';
    logger.error('[Gateway][AdminTx] VALIDATE:', { status, error });
    res.status(status).json({ success: false, error });
  }
};

// --- CANCEL
exports.cancelTransaction = async (req, res) => {
  const targetService = getTargetService(req);
  if (!targetService) return res.status(400).json({ success: false, error: 'Provider inconnu' });
  try {
    const response = await axios.post(
      `${targetService}/admin/transactions/${req.params.id}/cancel`,
      req.body,
      { headers: auditHeaders(req), timeout: 15000 }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error  = err.response?.data?.error || 'Erreur proxy CANCEL';
    logger.error('[Gateway][AdminTx] CANCEL:', { status, error });
    res.status(status).json({ success: false, error });
  }
};

// --- REFUND
exports.refundTransaction = async (req, res) => {
  const targetService = getTargetService(req);
  if (!targetService) return res.status(400).json({ success: false, error: 'Provider inconnu' });
  try {
    const response = await axios.post(
      `${targetService}/admin/transactions/${req.params.id}/refund`,
      req.body,
      { headers: auditHeaders(req), timeout: 15000 }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error  = err.response?.data?.error || 'Erreur proxy REFUND';
    logger.error('[Gateway][AdminTx] REFUND:', { status, error });
    res.status(status).json({ success: false, error });
  }
};

// --- REASSIGN
exports.reassignTransaction = async (req, res) => {
  const targetService = getTargetService(req);
  if (!targetService) return res.status(400).json({ success: false, error: 'Provider inconnu' });
  try {
    const response = await axios.post(
      `${targetService}/admin/transactions/${req.params.id}/reassign`,
      req.body,
      { headers: auditHeaders(req), timeout: 15000 }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error  = err.response?.data?.error || 'Erreur proxy REASSIGN';
    logger.error('[Gateway][AdminTx] REASSIGN:', { status, error });
    res.status(status).json({ success: false, error });
  }
};

// --- RELAUNCH
exports.relaunchTransaction = async (req, res) => {
  const targetService = getTargetService(req);
  if (!targetService) return res.status(400).json({ success: false, error: 'Provider inconnu' });
  try {
    const response = await axios.post(
      `${targetService}/admin/transactions/${req.params.id}/relaunch`,
      req.body,
      { headers: auditHeaders(req), timeout: 15000 }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error  = err.response?.data?.error || 'Erreur proxy RELAUNCH';
    logger.error('[Gateway][AdminTx] RELAUNCH:', { status, error });
    res.status(status).json({ success: false, error });
  }
};

// --- ARCHIVE
exports.archiveTransaction = async (req, res) => {
  const targetService = getTargetService(req);
  if (!targetService) return res.status(400).json({ success: false, error: 'Provider inconnu' });
  try {
    const response = await axios.post(
      `${targetService}/admin/transactions/${req.params.id}/archive`,
      req.body,
      { headers: auditHeaders(req), timeout: 15000 }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error  = err.response?.data?.error || 'Erreur proxy ARCHIVE';
    logger.error('[Gateway][AdminTx] ARCHIVE:', { status, error });
    res.status(status).json({ success: false, error });
  }
};

// --- UPDATE
exports.updateTransaction = async (req, res) => {
  const targetService = getTargetService(req);
  if (!targetService) return res.status(400).json({ success: false, error: 'Provider inconnu' });
  try {
    const response = await axios.put(
      `${targetService}/admin/transactions/${req.params.id}`,
      req.body,
      { headers: auditHeaders(req), timeout: 15000 }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error  = err.response?.data?.error || 'Erreur proxy UPDATE';
    logger.error('[Gateway][AdminTx] UPDATE:', { status, error });
    res.status(status).json({ success: false, error });
  }
};

// --- SOFT DELETE (AML)
exports.softDeleteTransaction = async (req, res) => {
  const targetService = getTargetService(req);
  if (!targetService) return res.status(400).json({ success: false, error: 'Provider inconnu' });
  try {
    const response = await axios.delete(
      `${targetService}/admin/transactions/${req.params.id}`,
      {
        headers: auditHeaders(req),
        timeout: 15000,
        data: req.body, // certains clients supportent le body en DELETE
      }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error  = err.response?.data?.error || 'Erreur proxy DELETE';
    logger.error('[Gateway][AdminTx] DELETE:', { status, error });
    res.status(status).json({ success: false, error });
  }
};

// --- EXPORT CSV
exports.exportTransactionsCsv = async (req, res) => {
  const targetService = getTargetService(req);
  if (!targetService) return res.status(400).json({ success: false, error: 'Provider inconnu' });
  try {
    const response = await axios.get(
      `${targetService}/admin/transactions/export/csv`,
      {
        headers: auditHeaders(req),
        params: req.query,
        responseType: 'stream',
        timeout: 30000,
      }
    );
    // On passe les headers CSV tels quels (download)
    res.setHeader('Content-Disposition', response.headers['content-disposition'] || 'attachment; filename="export.csv"');
    res.setHeader('Content-Type', 'text/csv');
    response.data.pipe(res);
  } catch (err) {
    const status = err.response?.status || 502;
    const error  = err.response?.data?.error || 'Erreur proxy EXPORT CSV';
    logger.error('[Gateway][AdminTx] EXPORT CSV:', { status, error });
    res.status(status).json({ success: false, error });
  }
};
