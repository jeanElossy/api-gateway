
// // File: api-gateway/controllers/transactionsController.js
// 'use strict';

// /**
//  * -------------------------------------------------------------------
//  * CONTROLLER TRANSACTIONS (API GATEWAY)
//  * -------------------------------------------------------------------
//  * Rôle de ce fichier :
//  *  - Proxyer les appels "transactions" vers les microservices providers
//  *  - Journaliser côté Gateway (Transaction + AMLLog) pour traçabilité
//  *  - Appliquer une couche de sécurité générique (question + code) pour certains providers
//  *  - Déclencher des emails transactionnels (hors PayNoval interne)
//  *  - Gérer les commissions admin (hors PayNoval interne)
//  *  - Déclencher la logique de parrainage :
//  *      1) logique "programme" (seuils/bonus) via referralUtils
//  *      2) notification interne vers backend principal pour assurer la génération du code PNV-XXXX
//  *
//  * ✅ FIX IMPORTANT (2025-12) :
//  *  - Le parrainage doit s'appliquer à l'EXPÉDITEUR (initiateur), pas à celui qui confirme.
//  *  - Or /transactions/confirm est souvent appelé par le destinataire.
//  *  => On stocke explicitement ownerUserId à l'initiate, et au confirm on utilise ownerUserId.
//  */

// const axios = require('axios');
// const config = require('../src/config');
// const logger = require('../src/logger');
// const Transaction = require('../src/models/Transaction');
// const AMLLog = require('../src/models/AMLLog');
// const crypto = require('crypto');

// // ⬇️ Service d’email transactionnel centralisé (SendGrid + templates)
// const { notifyTransactionEvent } = require('../src/services/transactionNotificationService');

// // ⬇️ Utilitaires de parrainage (logique programme : seuils/bonus, etc.)
// const {
//   checkAndGenerateReferralCodeInMain,
//   processReferralBonusIfEligible,
// } = require('../src/utils/referralUtils');

// // ⬇️ Service gateway -> backend principal (route interne) pour "assurer" la génération du code PNV-XXXX
// const { notifyReferralOnConfirm } = require('../src/services/referralGatewayService');

// // 🌐 Backend principal (API Users / Wallet / Notifications)
// const PRINCIPAL_URL = (config.principalUrl || process.env.PRINCIPAL_URL || '').replace(/\/+$/, '');

// // 🧑‍💼 ID MongoDB de l’admin (admin@paynoval.com) – à configurer en ENV
// // ex: ADMIN_USER_ID=6920a9528e93adc20e71d2cf
// const ADMIN_USER_ID = config.adminUserId || process.env.ADMIN_USER_ID || null;

// /**
//  * Mapping centralisé des providers -> service URL
//  * Ajoute ici toute nouvelle intégration (flutterwave, stripe, etc.)
//  */
// const PROVIDER_TO_SERVICE = {
//   paynoval: config.microservices.paynoval,
//   stripe: config.microservices.stripe,
//   bank: config.microservices.bank,
//   mobilemoney: config.microservices.mobilemoney,
//   visa_direct: config.microservices.visa_direct,
//   visadirect: config.microservices.visa_direct, // alias
//   cashin: config.microservices.cashin,
//   cashout: config.microservices.cashout,
//   stripe2momo: config.microservices.stripe2momo,
//   flutterwave: config.microservices.flutterwave, // NEW
// };

// // User-Agent par défaut pour tous les appels sortants du Gateway
// const GATEWAY_USER_AGENT =
//   config.gatewayUserAgent || 'PayNoval-Gateway/1.0 (+https://paynoval.com)';

// /**
//  * safeUUID()
//  * -------------------------------------------------------------------
//  * Génère un identifiant de requête.
//  * - Si crypto.randomUUID existe (Node récent), on l'utilise.
//  * - Sinon fallback simple (timestamp + random).
//  * Objectif :
//  * - tracer facilement les requêtes dans les logs (x-request-id)
//  */
// function safeUUID() {
//   if (crypto && typeof crypto.randomUUID === 'function') {
//     try {
//       return crypto.randomUUID();
//     } catch (e) {
//       // fallback
//     }
//   }
//   return (
//     Date.now().toString(16) +
//     '-' +
//     Math.floor(Math.random() * 0xffff).toString(16) +
//     '-' +
//     Math.floor(Math.random() * 0xffff).toString(16)
//   );
// }

// /**
//  * cleanSensitiveMeta(meta)
//  * -------------------------------------------------------------------
//  * Nettoie un objet "meta" avant stockage ou logs :
//  * - Masque les numéros de carte
//  * - Supprime cvc / securityCode
//  * Objectif :
//  * - conformité & sécurité : ne jamais stocker des secrets en clair.
//  */
// function cleanSensitiveMeta(meta = {}) {
//   const clone = { ...meta };
//   if (clone.cardNumber) {
//     clone.cardNumber = '****' + String(clone.cardNumber).slice(-4);
//   }
//   if (clone.cvc) delete clone.cvc;
//   if (clone.securityCode) delete clone.securityCode;
//   return clone;
// }

// /**
//  * getUserId(req)
//  * -------------------------------------------------------------------
//  * Extrait l'identifiant utilisateur de façon robuste.
//  * Objectif :
//  * - éviter les crash si req.user change de forme (id ou _id).
//  */
// function getUserId(req) {
//   return req.user?._id || req.user?.id || null;
// }

// /**
//  * resolveProvider(req, fallback)
//  * -------------------------------------------------------------------
//  * Détermine le provider ciblé (microservice) à partir de :
//  * - req.routedProvider (si route dynamique)
//  * - body.provider
//  * - body.destination
//  * - query.provider
//  * - fallback (par défaut paynoval)
//  */
// function resolveProvider(req, fallback = 'paynoval') {
//   const body = req.body || {};
//   const query = req.query || {};
//   return req.routedProvider || body.provider || body.destination || query.provider || fallback;
// }

// /**
//  * getTxOwnerUserId(gatewayTx, fallbackReqUserId, reqBody)
//  * -------------------------------------------------------------------
//  * ✅ Fix parrainage : renvoyer l'EXPÉDITEUR (initiateur) de la transaction.
//  * On ne doit JAMAIS dépendre du userId du "confirm" (souvent destinataire).
//  */
// function getTxOwnerUserId(gatewayTx, fallbackReqUserId, reqBody = {}) {
//   return (
//     gatewayTx?.ownerUserId ||
//     gatewayTx?.initiatorUserId ||
//     gatewayTx?.fromUserId ||
//     gatewayTx?.senderId ||
//     gatewayTx?.createdBy ||
//     gatewayTx?.userId || // dernier recours si ton modèle stocke bien l'expéditeur ici
//     reqBody?.ownerUserId ||
//     reqBody?.fromUserId ||
//     reqBody?.senderId ||
//     reqBody?.initiatorUserId ||
//     fallbackReqUserId ||
//     null
//   );
// }

// /**
//  * auditForwardHeaders(req)
//  * -------------------------------------------------------------------
//  * Construit les headers à transmettre aux microservices :
//  * - Authorization (uniquement si valide)
//  * - x-internal-token (auth inter-services)
//  * - x-request-id (trace)
//  * - x-user-id / x-session-id / x-device-id (traçabilité / anti-fraude)
//  */
// function auditForwardHeaders(req) {
//   const incomingAuth = req.headers.authorization || req.headers.Authorization || null;

//   // On ignore les Authorization invalides type "Bearer null"
//   const hasAuth =
//     !!incomingAuth &&
//     String(incomingAuth).toLowerCase() !== 'bearer null' &&
//     String(incomingAuth).trim().toLowerCase() !== 'null';

//   const reqId = req.headers['x-request-id'] || req.id || safeUUID();
//   const userId = getUserId(req) || req.headers['x-user-id'] || '';

//   const headers = {
//     Accept: 'application/json',
//     'x-internal-token': config.internalToken || '',
//     'x-request-id': reqId,
//     'x-user-id': userId,
//     'x-session-id': req.headers['x-session-id'] || '',
//     ...(req.headers['x-device-id'] ? { 'x-device-id': req.headers['x-device-id'] } : {}),
//   };

//   if (hasAuth) headers.Authorization = incomingAuth;

//   // Logs debug "safe" (on ne log jamais le token complet)
//   try {
//     const authPreview = headers.Authorization ? String(headers.Authorization).slice(0, 12) : null;
//     logger.debug('[Gateway][AUDIT HEADERS] forwarding', {
//       authPreview,
//       xInternalToken: headers['x-internal-token'] ? 'present' : 'missing',
//       requestId: reqId,
//       userId,
//       dest: req.path,
//     });
//   } catch (e) {
//     // noop
//   }

//   return headers;
// }

// /**
//  * isCloudflareChallengeResponse(response)
//  * -------------------------------------------------------------------
//  * Détecte une réponse Cloudflare "challenge" (HTML) qui casse les appels API.
//  */
// function isCloudflareChallengeResponse(response) {
//   if (!response) return false;
//   const status = response.status;
//   const data = response.data;

//   if (!data || typeof data !== 'string') return false;
//   const lower = data.toLowerCase();

//   const looksLikeHtml = lower.includes('<html') || lower.includes('<!doctype html');

//   const hasCloudflareMarkers =
//     lower.includes('just a moment') ||
//     lower.includes('attention required') ||
//     lower.includes('cdn-cgi/challenge-platform') ||
//     lower.includes('__cf_chl_') ||
//     lower.includes('cloudflare');

//   const suspiciousStatus = status === 403 || status === 429 || status === 503;

//   return hasCloudflareMarkers && (suspiciousStatus || looksLikeHtml);
// }

// /**
//  * safeAxiosRequest(opts)
//  * -------------------------------------------------------------------
//  * Wrapper Axios centralisé :
//  * - Ajoute un User-Agent propre
//  * - Ajoute un timeout par défaut
//  * - Détecte Cloudflare challenge
//  * - Logue les erreurs (avec preview du body)
//  */
// async function safeAxiosRequest(opts) {
//   const finalOpts = { ...opts };

//   if (!finalOpts.timeout) finalOpts.timeout = 15000;
//   finalOpts.method = finalOpts.method || 'get';

//   finalOpts.headers = { ...(finalOpts.headers || {}) };
//   const hasUA = finalOpts.headers['User-Agent'] || finalOpts.headers['user-agent'];
//   if (!hasUA) finalOpts.headers['User-Agent'] = GATEWAY_USER_AGENT;

//   try {
//     const response = await axios(finalOpts);

//     if (isCloudflareChallengeResponse(response)) {
//       const e = new Error('Cloudflare challenge détecté');
//       e.response = response;
//       e.isCloudflareChallenge = true;
//       throw e;
//     }

//     return response;
//   } catch (err) {
//     const status = err.response?.status || 502;
//     const data = err.response?.data || null;
//     const message = err.message || 'Erreur axios inconnue';

//     const preview = typeof data === 'string' ? data.slice(0, 300) : data;
//     const isCf = err.isCloudflareChallenge || isCloudflareChallengeResponse(err.response);
//     const isRateLimited = status === 429;

//     logger.error('[Gateway][Axios] request failed', {
//       url: finalOpts.url,
//       method: finalOpts.method,
//       status,
//       isCloudflare: isCf,
//       isRateLimited,
//       dataPreview: preview,
//       message,
//     });

//     const e = new Error(message);
//     e.response = err.response;
//     e.isCloudflareChallenge = isCf;
//     e.isRateLimited = isRateLimited;
//     throw e;
//   }
// }

// /**
//  * hashSecurityCode(code)
//  * -------------------------------------------------------------------
//  * Hash SHA256 simple du code de sécurité.
//  */
// function hashSecurityCode(code) {
//   return crypto.createHash('sha256').update(String(code || '').trim()).digest('hex');
// }

// /**
//  * creditAdminCommissionFromGateway({provider, kind, amount, currency, req})
//  * -------------------------------------------------------------------
//  * Crédite la commission sur le compte admin dans le backend principal.
//  */
// async function creditAdminCommissionFromGateway({ provider, kind, amount, currency, req }) {
//   try {
//     if (!PRINCIPAL_URL || !ADMIN_USER_ID) {
//       logger.warn(
//         '[Gateway][Fees] PRINCIPAL_URL ou ADMIN_USER_ID manquant, commission admin non créditée.'
//       );
//       return;
//     }

//     const num = parseFloat(amount);
//     if (!num || Number.isNaN(num) || num <= 0) return;

//     const url = `${PRINCIPAL_URL}/users/${ADMIN_USER_ID}/credit`;

//     const authHeader = req.headers.authorization || req.headers.Authorization || null;
//     const headers = {};
//     if (authHeader && String(authHeader).toLowerCase().startsWith('bearer ')) {
//       headers.Authorization = authHeader;
//     }

//     const description = `Commission PayNoval (${kind}) - provider=${provider}`;

//     await safeAxiosRequest({
//       method: 'post',
//       url,
//       data: { amount: num, currency: currency || 'CAD', description },
//       headers,
//       timeout: 10000,
//     });

//     logger.info('[Gateway][Fees] Crédit admin OK', {
//       provider,
//       kind,
//       amount: num,
//       currency: currency || 'CAD',
//       adminUserId: ADMIN_USER_ID,
//     });
//   } catch (err) {
//     logger.error('[Gateway][Fees] Échec crédit admin', {
//       provider,
//       kind,
//       amount,
//       currency,
//       message: err.message,
//     });
//   }
// }

// /**
//  * triggerGatewayTxEmail(type, { provider, req, result, reference })
//  * -------------------------------------------------------------------
//  * Envoie les emails transactionnels via notifyTransactionEvent
//  */
// async function triggerGatewayTxEmail(type, { provider, req, result, reference }) {
//   try {
//     if (provider === 'paynoval') return;

//     const user = req.user || {};
//     const senderEmail = user.email || user.username || req.body.senderEmail || null;
//     const senderName = user.fullName || user.name || req.body.senderName || senderEmail;

//     const receiverEmail = result.receiverEmail || result.toEmail || req.body.toEmail || null;
//     const receiverName = result.receiverName || req.body.receiverName || receiverEmail;

//     if (!senderEmail && !receiverEmail) {
//       logger.warn('[Gateway][TX] triggerGatewayTxEmail: aucun email sender/receiver, skip.');
//       return;
//     }

//     const txId = result.transactionId || result.id || reference || null;
//     const txReference = reference || result.reference || null;
//     const amount = result.amount || req.body.amount || 0;

//     const currency =
//       result.currency ||
//       req.body.currency ||
//       req.body.senderCurrencySymbol ||
//       req.body.localCurrencySymbol ||
//       '---';

//     const frontendBase =
//       config.frontendUrl ||
//       config.frontUrl ||
//       (Array.isArray(config.cors?.origins) && config.cors.origins[0]) ||
//       'https://www.paynoval.com';

//     const payload = {
//       type,
//       provider,
//       transaction: {
//         id: txId,
//         reference: txReference,
//         amount,
//         currency,
//         dateIso: new Date().toISOString(),
//       },
//       sender: { email: senderEmail, name: senderName || senderEmail },
//       receiver: { email: receiverEmail, name: receiverName || receiverEmail },
//       reason: type === 'cancelled' ? result.reason || req.body.reason || '' : undefined,
//       links: {
//         sender: `${frontendBase}/transactions`,
//         receiverConfirm: txId
//           ? `${frontendBase}/transactions/confirm/${encodeURIComponent(txId)}`
//           : '',
//       },
//     };

//     await notifyTransactionEvent(payload);
//     logger.info('[Gateway][TX] triggerGatewayTxEmail OK', {
//       type,
//       provider,
//       txId,
//       senderEmail,
//       receiverEmail,
//     });
//   } catch (err) {
//     logger.error('[Gateway][TX] triggerGatewayTxEmail ERROR', {
//       type,
//       provider,
//       message: err.message,
//     });
//   }
// }

// /* -------------------------------------------------------------------
//  *                       CONTROLLER ACTIONS
//  * -------------------------------------------------------------------
//  */

// /**
//  * GET /transactions/:id
//  */
// exports.getTransaction = async (req, res) => {
//   const provider = resolveProvider(req, 'paynoval');
//   const targetService = PROVIDER_TO_SERVICE[provider];

//   if (!targetService) {
//     return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
//   }

//   const { id } = req.params;
//   const base = String(targetService).replace(/\/+$/, '');
//   const url = `${base}/transactions/${encodeURIComponent(id)}`;

//   try {
//     const response = await safeAxiosRequest({
//       method: 'get',
//       url,
//       headers: auditForwardHeaders(req),
//       params: req.query,
//       timeout: 10000,
//     });
//     return res.status(response.status).json(response.data);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       logger.error('[Gateway][TX] Cloudflare challenge détecté sur GET transaction', {
//         provider,
//         transactionId: id,
//         upstreamStatus: err.response?.status,
//       });

//       return res.status(503).json({
//         success: false,
//         error:
//           'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
//         details: 'cloudflare_challenge',
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === 'string' ? err.response.data : null) ||
//       'Erreur lors du proxy GET transaction';

//     if (status === 429) {
//       error =
//         'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
//     }

//     logger.error('[Gateway][TX] Erreur GET transaction:', { status, error, provider, transactionId: id });
//     return res.status(status).json({ success: false, error });
//   }
// };

// /**
//  * GET /transactions
//  */
// exports.listTransactions = async (req, res) => {
//   const provider = resolveProvider(req, 'paynoval');
//   const targetService = PROVIDER_TO_SERVICE[provider];

//   if (!targetService) {
//     return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
//   }

//   const base = String(targetService).replace(/\/+$/, '');
//   const url = `${base}/transactions`;

//   try {
//     const response = await safeAxiosRequest({
//       method: 'get',
//       url,
//       headers: auditForwardHeaders(req),
//       params: req.query,
//       timeout: 15000,
//     });
//     return res.status(response.status).json(response.data);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       logger.error('[Gateway][TX] Cloudflare challenge détecté sur GET transactions', {
//         provider,
//         upstreamStatus: err.response?.status,
//         path: '/transactions',
//       });

//       return res.status(503).json({
//         success: false,
//         error:
//           'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
//         details: 'cloudflare_challenge',
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === 'string' ? err.response.data : null) ||
//       'Erreur lors du proxy GET transactions';

//     if (status === 429) {
//       error =
//         'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
//     }

//     logger.error('[Gateway][TX] Erreur GET transactions:', { status, error, provider });
//     return res.status(status).json({ success: false, error });
//   }
// };

// /**
//  * POST /transactions/initiate
//  * -------------------------------------------------------------------
//  * ✅ FIX :
//  * - On stocke ownerUserId/initiatorUserId (expéditeur) dès l'initiate.
//  */
// exports.initiateTransaction = async (req, res) => {
//   const targetProvider = resolveProvider(req, 'paynoval');
//   const targetService = PROVIDER_TO_SERVICE[targetProvider];
//   const targetUrl = targetService
//     ? String(targetService).replace(/\/+$/, '') + '/transactions/initiate'
//     : null;

//   logger.debug('[Gateway][TX] initiateTransaction targetUrl', { targetProvider, targetUrl });

//   if (!targetUrl) {
//     return res.status(400).json({ success: false, error: 'Provider (destination) inconnu.' });
//   }

//   const userId = getUserId(req); // ✅ expéditeur (celui qui initie)
//   const now = new Date();
//   let reference = null;
//   let statusResult = 'pending';

//   // 🔐 Sécurité obligatoire (question + code)
//   const securityQuestion = (req.body.securityQuestion || req.body.question || '').trim();
//   const securityCode = (req.body.securityCode || '').trim();

//   if (!securityQuestion || !securityCode) {
//     return res.status(400).json({
//       success: false,
//       error: 'Question et code de sécurité obligatoires pour initier une transaction.',
//     });
//   }
//   const securityCodeHash = hashSecurityCode(securityCode);

//   try {
//     // 1) Appel provider
//     const response = await safeAxiosRequest({
//       method: 'post',
//       url: targetUrl,
//       data: req.body,
//       headers: auditForwardHeaders(req),
//       timeout: 15000,
//     });

//     // 2) Résultat provider
//     const result = response.data;
//     reference = result.reference || result.id || null;
//     statusResult = result.status || 'pending';

//     // 3) AML log (initiate)
//     await AMLLog.create({
//       userId,
//       type: 'initiate',
//       provider: targetProvider,
//       amount: req.body.amount,
//       toEmail: req.body.toEmail || '',
//       details: cleanSensitiveMeta(req.body),
//       flagged: req.amlFlag || false,
//       flagReason: req.amlReason || '',
//       createdAt: now,
//     });

//     // 4) Journal "Transaction" côté Gateway
//     await Transaction.create({
//       userId, // compat legacy (chez toi)
//       ownerUserId: userId, // ✅ expéditeur (IMPORTANT pour parrainage)
//       initiatorUserId: userId, // ✅ alias (pratique)
//       // recipientUserId: req.body.recipientUserId || req.body.toUserId || undefined, // optionnel si tu l’as

//       provider: targetProvider,
//       amount: req.body.amount,
//       status: statusResult,
//       toEmail: req.body.toEmail || undefined,
//       toIBAN: req.body.iban || undefined,
//       toPhone: req.body.phoneNumber || undefined,
//       currency:
//         req.body.currency ||
//         req.body.senderCurrencySymbol ||
//         req.body.localCurrencySymbol ||
//         undefined,
//       operator: req.body.operator || undefined,
//       country: req.body.country || undefined,
//       reference,
//       meta: cleanSensitiveMeta(req.body),
//       createdAt: now,
//       updatedAt: now,

//       // 🔐 sécurité côté Gateway pour tous les providers
//       requiresSecurityValidation: true,
//       securityQuestion,
//       securityCodeHash,
//       securityAttempts: 0,
//       securityLockedUntil: null,
//     });

//     // 5) Email "initiated" (hors paynoval)
//     await triggerGatewayTxEmail('initiated', { provider: targetProvider, req, result, reference });

//     // 6) Commission admin globale pour tous les providers ≠ paynoval
//     if (targetProvider !== 'paynoval') {
//       try {
//         const rawFee = (result && (result.fees || result.fee || result.transactionFees)) || null;
//         if (rawFee) {
//           const feeAmount = parseFloat(rawFee);
//           if (!Number.isNaN(feeAmount) && feeAmount > 0) {
//             const feeCurrency =
//               result.feeCurrency ||
//               result.currency ||
//               req.body.currency ||
//               req.body.senderCurrencySymbol ||
//               req.body.localCurrencySymbol ||
//               'CAD';

//             await creditAdminCommissionFromGateway({
//               provider: targetProvider,
//               kind: 'transaction',
//               amount: feeAmount,
//               currency: feeCurrency,
//               req,
//             });
//           }
//         } else {
//           logger.debug(
//             '[Gateway][Fees] Aucun champ fees/fee/transactionFees dans la réponse provider, commission admin non calculée.',
//             { provider: targetProvider }
//           );
//         }
//       } catch (e) {
//         logger.error('[Gateway][Fees] Erreur crédit admin (initiate)', {
//           provider: targetProvider,
//           message: e.message,
//         });
//       }
//     }

//     return res.status(response.status).json(result);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       logger.error('[Gateway][TX] Cloudflare challenge détecté sur INITIATE', {
//         provider: targetProvider,
//         upstreamStatus: err.response?.status,
//       });

//       return res.status(503).json({
//         success: false,
//         error:
//           'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
//         details: 'cloudflare_challenge',
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === 'string' ? err.response.data : null) ||
//       err.message ||
//       'Erreur interne provider';

//     if (status === 429) {
//       error =
//         'Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.';
//     }

//     // AML log (initiate fail)
//     await AMLLog.create({
//       userId,
//       type: 'initiate',
//       provider: targetProvider,
//       amount: req.body.amount,
//       toEmail: req.body.toEmail || '',
//       details: cleanSensitiveMeta({ ...req.body, error }),
//       flagged: req.amlFlag || false,
//       flagReason: req.amlReason || '',
//       createdAt: now,
//     });

//     // Transaction gateway en échec
//     await Transaction.create({
//       userId,
//       ownerUserId: userId,
//       initiatorUserId: userId,

//       provider: targetProvider,
//       amount: req.body.amount,
//       status: 'failed',
//       toEmail: req.body.toEmail || undefined,
//       toIBAN: req.body.iban || undefined,
//       toPhone: req.body.phoneNumber || undefined,
//       currency:
//         req.body.currency ||
//         req.body.senderCurrencySymbol ||
//         req.body.localCurrencySymbol ||
//         undefined,
//       operator: req.body.operator || undefined,
//       country: req.body.country || undefined,
//       reference: null,
//       meta: cleanSensitiveMeta({ ...req.body, error }),
//       createdAt: now,
//       updatedAt: now,
//     });

//     logger.error('[Gateway][TX] initiateTransaction failed', {
//       provider: targetProvider,
//       error,
//       status,
//     });
//     return res.status(status).json({ success: false, error });
//   }
// };

// /**
//  * POST /transactions/confirm
//  * -------------------------------------------------------------------
//  * ✅ FIX :
//  * - referralUserId = ownerUserId (expéditeur), pas userId(req) (destinataire)
//  */
// exports.confirmTransaction = async (req, res) => {
//   const provider = resolveProvider(req, 'paynoval');
//   const { transactionId, securityCode } = req.body;

//   const targetService = PROVIDER_TO_SERVICE[provider];
//   const targetUrl = targetService
//     ? String(targetService).replace(/\/+$/, '') + '/transactions/confirm'
//     : null;

//   if (!targetUrl) {
//     return res.status(400).json({ success: false, error: 'Provider (destination) inconnu.' });
//   }

//   const confirmCallerUserId = getUserId(req); // ⚠️ souvent destinataire
//   const now = new Date();

//   // ✅ Normalisation robuste des statuts provider => statut "gateway"
//   const normalizeStatus = (raw) => {
//     const s = String(raw || '').toLowerCase().trim();
//     if (s === 'cancelled' || s === 'canceled') return 'canceled';
//     if (s === 'confirmed' || s === 'success' || s === 'validated' || s === 'completed')
//       return 'confirmed';
//     if (s === 'failed' || s === 'error' || s === 'declined' || s === 'rejected')
//       return 'failed';
//     if (s === 'pending' || s === 'processing' || s === 'in_progress') return 'pending';
//     return s || 'confirmed';
//   };

//   /**
//    * 1) Couche de sécurité côté Gateway (providers ≠ paynoval)
//    */
//   if (provider !== 'paynoval') {
//     const txRecord = await Transaction.findOne({ provider, reference: transactionId });

//     if (!txRecord) {
//       return res.status(404).json({ success: false, error: 'Transaction non trouvée dans le Gateway.' });
//     }

//     if (txRecord.status !== 'pending') {
//       return res.status(400).json({ success: false, error: 'Transaction déjà traitée ou annulée.' });
//     }

//     if (txRecord.requiresSecurityValidation && txRecord.securityCodeHash) {
//       if (txRecord.securityLockedUntil && txRecord.securityLockedUntil > now) {
//         return res.status(423).json({
//           success: false,
//           error:
//             'Transaction temporairement bloquée suite à des tentatives infructueuses. Réessayez plus tard.',
//         });
//       }

//       if (!securityCode) {
//         return res.status(400).json({
//           success: false,
//           error: 'securityCode requis pour confirmer cette transaction.',
//         });
//       }

//       const incomingHash = hashSecurityCode(securityCode);

//       if (incomingHash !== txRecord.securityCodeHash) {
//         const attempts = (txRecord.securityAttempts || 0) + 1;

//         const update = { securityAttempts: attempts, updatedAt: now };
//         let errorMsg;

//         if (attempts >= 3) {
//           update.status = 'canceled';
//           update.cancelledAt = now;
//           update.cancelReason = 'Code de sécurité erroné (trop d’essais)';
//           update.securityLockedUntil = new Date(now.getTime() + 15 * 60 * 1000);

//           errorMsg =
//             'Code de sécurité incorrect. Nombre d’essais dépassé, transaction annulée.';

//           await triggerGatewayTxEmail('cancelled', {
//             provider,
//             req,
//             result: {
//               ...txRecord.toObject(),
//               status: 'canceled',
//               amount: txRecord.amount,
//               toEmail: txRecord.toEmail,
//             },
//             reference: transactionId,
//           });
//         } else {
//           const remaining = 3 - attempts;
//           errorMsg = `Code de sécurité incorrect. Il vous reste ${remaining} essai(s).`;
//         }

//         await Transaction.updateOne({ _id: txRecord._id }, { $set: update });
//         return res.status(401).json({ success: false, error: errorMsg });
//       }

//       await Transaction.updateOne(
//         { _id: txRecord._id },
//         {
//           $set: {
//             securityAttempts: 0,
//             securityLockedUntil: null,
//             updatedAt: now,
//           },
//         }
//       );
//     }
//   }

//   /**
//    * 2) Appel au provider + update gateway
//    */
//   try {
//     const response = await safeAxiosRequest({
//       method: 'post',
//       url: targetUrl,
//       data: req.body,
//       headers: auditForwardHeaders(req),
//       timeout: 15000,
//     });

//     const result = response.data;

//     const newStatus = normalizeStatus(result.status || 'confirmed');

//     const refFromResult =
//       result.reference || result.transaction?.reference || req.body.reference || null;

//     const idFromResult = result.id || result.transaction?.id || transactionId || null;

//     const candidates = Array.from(
//       new Set([refFromResult, idFromResult, transactionId].filter(Boolean).map(String))
//     );

//     let query = { provider };
//     if (candidates.length > 0) {
//       query = {
//         provider,
//         $or: [
//           ...candidates.map((v) => ({ reference: v })),
//           ...candidates.map((v) => ({ 'meta.reference': v })),
//           ...candidates.map((v) => ({ 'meta.id': v })),
//         ],
//       };
//     }

//     // 3) AML log confirm
//     await AMLLog.create({
//       userId: confirmCallerUserId,
//       type: 'confirm',
//       provider,
//       amount: result.amount || 0,
//       toEmail: result.recipientEmail || result.toEmail || result.email || '',
//       details: cleanSensitiveMeta(req.body),
//       flagged: false,
//       flagReason: '',
//       createdAt: now,
//     });

//     // 4) Update Transaction Gateway + récup du doc
//     const gatewayTx = await Transaction.findOneAndUpdate(
//       query,
//       {
//         $set: {
//           status: newStatus,
//           confirmedAt: newStatus === 'confirmed' ? now : undefined,
//           cancelledAt: newStatus === 'canceled' ? now : undefined,
//           updatedAt: now,
//         },
//       },
//       { new: true }
//     );

//     if (!gatewayTx) {
//       logger.warn('[Gateway][TX] confirmTransaction: aucune transaction Gateway trouvée à mettre à jour', {
//         provider,
//         transactionId,
//         refFromResult,
//         candidates,
//       });
//     }

//     // 5) Email selon statut final
//     if (newStatus === 'confirmed') {
//       await triggerGatewayTxEmail('confirmed', { provider, req, result, reference: refFromResult || transactionId });
//     } else if (newStatus === 'canceled') {
//       await triggerGatewayTxEmail('cancelled', { provider, req, result, reference: refFromResult || transactionId });
//     } else if (newStatus === 'failed') {
//       await triggerGatewayTxEmail('failed', { provider, req, result, reference: refFromResult || transactionId });
//     }

//     /**
//      * 6) PARRAINAGE (SEULEMENT SI CONFIRMÉ)
//      * ✅ referralUserId = EXPÉDITEUR (ownerUserId)
//      */
//     if (newStatus === 'confirmed') {
//       const referralUserId = getTxOwnerUserId(gatewayTx, confirmCallerUserId, req.body);

//       if (!referralUserId) {
//         logger.warn('[Gateway][TX][Referral] referralUserId introuvable -> skip', {
//           provider,
//           transactionId,
//           gatewayTxId: gatewayTx?._id,
//         });
//       } else {
//         try {
//           const txIdSafe = result.id || result.transaction?.id || transactionId || null;
//           const refSafe = result.reference || result.transaction?.reference || transactionId || null;

//           const txForReferral = {
//             id: String(txIdSafe || refSafe || ''),
//             reference: refSafe ? String(refSafe) : '',
//             status: 'confirmed',
//             amount: Number(result.amount || gatewayTx?.amount || 0),
//             currency: String(result.currency || gatewayTx?.currency || req.body.currency || 'CAD'),
//             country: String(result.country || gatewayTx?.country || req.body.country || ''),
//             provider: String(provider),
//             createdAt: gatewayTx?.createdAt
//               ? new Date(gatewayTx.createdAt).toISOString()
//               : new Date().toISOString(),
//             confirmedAt: new Date().toISOString(),
//           };

//           // A) Assure le code referral (1ère tx confirmée suffit)
//           await checkAndGenerateReferralCodeInMain(referralUserId, null, txForReferral);

//           // B) Bonus si éligible (>=2 tx confirmées + seuil + referredBy)
//           await processReferralBonusIfEligible(referralUserId, null);
//         } catch (e) {
//           logger.warn('[Gateway][TX][Referral] parrainage skipped/failed', { message: e?.message });
//         }

//         // Best effort : appelle aussi la route interne "ensure code"
//         try {
//           const txIdSafe = result.id || result.transaction?.id || transactionId || null;
//           const refSafe = result.reference || result.transaction?.reference || transactionId || null;

//           await notifyReferralOnConfirm({
//             userId: referralUserId,
//             provider,
//             transaction: {
//               id: String(txIdSafe || refSafe || ''),
//               reference: refSafe ? String(refSafe) : '',
//               amount: Number(result.amount || gatewayTx?.amount || 0),
//               currency: String(result.currency || gatewayTx?.currency || req.body.currency || 'CAD'),
//               country: String(result.country || gatewayTx?.country || req.body.country || ''),
//               provider: String(provider),
//               confirmedAt: new Date().toISOString(),
//             },
//             requestId: req.id,
//           });
//         } catch (e) {
//           logger.warn('[Gateway][Referral] notifyReferralOnConfirm skipped/failed', { message: e?.message });
//         }
//       }
//     }

//     return res.status(response.status).json(result);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       logger.error('[Gateway][TX] Cloudflare challenge détecté sur CONFIRM', {
//         provider,
//         upstreamStatus: err.response?.status,
//       });

//       return res.status(503).json({
//         success: false,
//         error:
//           'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
//         details: 'cloudflare_challenge',
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === 'string' ? err.response.data : null) ||
//       err.message ||
//       'Erreur interne provider';

//     if (status === 429) {
//       error =
//         'Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.';
//     }

//     // AML log confirm fail
//     await AMLLog.create({
//       userId: confirmCallerUserId,
//       type: 'confirm',
//       provider,
//       amount: 0,
//       toEmail: '',
//       details: cleanSensitiveMeta({ ...req.body, error }),
//       flagged: false,
//       flagReason: '',
//       createdAt: now,
//     });

//     // Update transaction gateway fail (best effort)
//     await Transaction.findOneAndUpdate(
//       {
//         provider,
//         $or: [
//           { reference: transactionId },
//           { 'meta.reference': transactionId },
//           { 'meta.id': transactionId },
//         ],
//       },
//       { $set: { status: 'failed', updatedAt: now } }
//     );

//     logger.error('[Gateway][TX] confirmTransaction failed', { provider, error, status });
//     return res.status(status).json({ success: false, error });
//   }
// };

// /**
//  * POST /transactions/cancel
//  */
// exports.cancelTransaction = async (req, res) => {
//   const provider = resolveProvider(req, 'paynoval');
//   const { transactionId } = req.body;

//   const targetService = PROVIDER_TO_SERVICE[provider];
//   const targetUrl = targetService
//     ? String(targetService).replace(/\/+$/, '') + '/transactions/cancel'
//     : null;

//   if (!targetUrl) {
//     return res.status(400).json({ success: false, error: 'Provider (destination) inconnu.' });
//   }

//   const userId = getUserId(req);
//   const now = new Date();

//   try {
//     const response = await safeAxiosRequest({
//       method: 'post',
//       url: targetUrl,
//       data: req.body,
//       headers: auditForwardHeaders(req),
//       timeout: 15000,
//     });

//     const result = response.data;
//     const newStatus = result.status || 'canceled';

//     await AMLLog.create({
//       userId,
//       type: 'cancel',
//       provider,
//       amount: result.amount || 0,
//       toEmail: result.toEmail || '',
//       details: cleanSensitiveMeta(req.body),
//       flagged: false,
//       flagReason: '',
//       createdAt: now,
//     });

//     await Transaction.findOneAndUpdate(
//       { $or: [{ reference: transactionId }, { 'meta.reference': transactionId }, { 'meta.id': transactionId }] },
//       {
//         $set: {
//           status: newStatus,
//           cancelledAt: now,
//           cancelReason: req.body.reason || result.reason || '',
//           updatedAt: now,
//         },
//       }
//     );

//     await triggerGatewayTxEmail('cancelled', { provider, req, result, reference: transactionId });

//     if (provider !== 'paynoval') {
//       try {
//         const rawCancellationFee =
//           result.cancellationFeeInSenderCurrency || result.cancellationFee || result.fees || null;

//         if (rawCancellationFee) {
//           const feeAmount = parseFloat(rawCancellationFee);
//           if (!Number.isNaN(feeAmount) && feeAmount > 0) {
//             const feeCurrency =
//               result.adminCurrency ||
//               result.currency ||
//               req.body.currency ||
//               req.body.senderCurrencySymbol ||
//               'CAD';

//             await creditAdminCommissionFromGateway({
//               provider,
//               kind: 'cancellation',
//               amount: feeAmount,
//               currency: feeCurrency,
//               req,
//             });
//           }
//         } else {
//           logger.debug(
//             '[Gateway][Fees] Aucun champ cancellationFee*/fees dans la réponse provider, pas de commission admin.',
//             { provider }
//           );
//         }
//       } catch (e) {
//         logger.error('[Gateway][Fees] Erreur crédit admin (cancel)', { provider, message: e.message });
//       }
//     }

//     return res.status(response.status).json(result);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       logger.error('[Gateway][TX] Cloudflare challenge détecté sur CANCEL', {
//         provider,
//         upstreamStatus: err.response?.status,
//       });

//       return res.status(503).json({
//         success: false,
//         error:
//           'Service de paiement temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
//         details: 'cloudflare_challenge',
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === 'string' ? err.response.data : null) ||
//       err.message ||
//       'Erreur interne provider';

//     if (status === 429) {
//       error =
//         'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
//     }

//     await AMLLog.create({
//       userId,
//       type: 'cancel',
//       provider,
//       amount: 0,
//       toEmail: '',
//       details: cleanSensitiveMeta({ ...req.body, error }),
//       flagged: false,
//       flagReason: '',
//       createdAt: now,
//     });

//     await Transaction.findOneAndUpdate(
//       { $or: [{ reference: transactionId }, { 'meta.reference': transactionId }, { 'meta.id': transactionId }] },
//       { $set: { status: 'failed', updatedAt: now } }
//     );

//     logger.error('[Gateway][TX] cancelTransaction failed', { provider, error, status });
//     return res.status(status).json({ success: false, error });
//   }
// };

// /**
//  * POST /transactions/internal/log
//  */
// exports.logInternalTransaction = async (req, res) => {
//   try {
//     const headerToken = req.headers['x-internal-token'] || '';
//     const expectedToken = config.internalToken || process.env.INTERNAL_LOG_TOKEN || '';

//     if (expectedToken && headerToken !== expectedToken) {
//       logger.warn('[Gateway][TX] logInternalTransaction: token interne invalide');
//       return res.status(401).json({ success: false, error: 'Appel interne non autorisé.' });
//     }

//     const now = new Date();
//     const userId = getUserId(req) || req.body.userId;

//     if (!userId) {
//       return res.status(400).json({ success: false, error: 'userId manquant pour loguer la transaction.' });
//     }

//     const {
//       provider = 'paynoval',
//       amount,
//       status = 'confirmed',
//       currency,
//       operator = 'paynoval',
//       country,
//       reference,
//       meta = {},
//       createdBy,
//       receiver,
//       fees,
//       netAmount,
//       ownerUserId,
//       initiatorUserId,
//     } = req.body || {};

//     const numAmount = Number(amount);
//     if (!numAmount || Number.isNaN(numAmount) || numAmount <= 0) {
//       return res.status(400).json({ success: false, error: 'amount invalide ou manquant pour loguer la transaction.' });
//     }

//     const tx = await Transaction.create({
//       userId,
//       ownerUserId: ownerUserId || initiatorUserId || createdBy || userId,
//       initiatorUserId: initiatorUserId || ownerUserId || createdBy || userId,

//       provider,
//       amount: numAmount,
//       status,
//       currency,
//       operator,
//       country,
//       reference,
//       requiresSecurityValidation: false,
//       securityAttempts: 0,
//       securityLockedUntil: null,
//       confirmedAt: status === 'confirmed' ? now : undefined,
//       meta: cleanSensitiveMeta(meta),
//       createdAt: now,
//       updatedAt: now,
//       createdBy: createdBy || userId,
//       receiver: receiver || userId,
//       fees: typeof fees === 'number' ? fees : undefined,
//       netAmount: typeof netAmount === 'number' ? netAmount : undefined,
//     });

//     return res.status(201).json({ success: true, data: tx });
//   } catch (err) {
//     logger.error('[Gateway][TX] logInternalTransaction error', { message: err.message, stack: err.stack });
//     return res.status(500).json({
//       success: false,
//       error: 'Erreur lors de la création de la transaction interne.',
//     });
//   }
// };

// /**
//  * Les actions admin/ops ci-dessous suivent le même pattern :
//  */
// exports.refundTransaction = async (req, res) => forwardTransactionProxy(req, res, 'refund');
// exports.reassignTransaction = async (req, res) => forwardTransactionProxy(req, res, 'reassign');
// exports.validateTransaction = async (req, res) => forwardTransactionProxy(req, res, 'validate');
// exports.archiveTransaction = async (req, res) => forwardTransactionProxy(req, res, 'archive');
// exports.relaunchTransaction = async (req, res) => forwardTransactionProxy(req, res, 'relaunch');

// /**
//  * forwardTransactionProxy(req, res, action)
//  */
// async function forwardTransactionProxy(req, res, action) {
//   const provider = resolveProvider(req, 'paynoval');
//   const targetService = PROVIDER_TO_SERVICE[provider];

//   if (!targetService) {
//     return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
//   }

//   const url = String(targetService).replace(/\/+$/, '') + `/transactions/${action}`;

//   try {
//     const response = await safeAxiosRequest({
//       method: 'post',
//       url,
//       data: req.body,
//       headers: auditForwardHeaders(req),
//       timeout: 15000,
//     });

//     return res.status(response.status).json(response.data);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       logger.error('[Gateway][TX] Cloudflare challenge détecté sur action', {
//         provider,
//         action,
//         upstreamStatus: err.response?.status,
//       });

//       return res.status(503).json({
//         success: false,
//         error:
//           'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
//         details: 'cloudflare_challenge',
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === 'string' ? err.response.data : null) ||
//       err.message ||
//       `Erreur proxy ${action}`;

//     if (status === 429) {
//       error =
//         'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
//     }

//     logger.error(`[Gateway][TX] Erreur ${action}:`, { status, error, provider });
//     return res.status(status).json({ success: false, error });
//   }
// }






// File: api-gateway/controllers/transactionsController.js
'use strict';

/**
 * -------------------------------------------------------------------
 * CONTROLLER TRANSACTIONS (API GATEWAY)
 * -------------------------------------------------------------------
 * ✅ FIX IMPORTANT (2025-12) :
 *  - Le parrainage doit s'appliquer à l'EXPÉDITEUR (initiateur), pas à celui qui confirme.
 *  - Or /transactions/confirm est souvent appelé par le destinataire.
 *  => On stocke explicitement ownerUserId à l'initiate, et au confirm on utilise ownerUserId.
 *  => IMPORTANT : si on ne retrouve pas la TX Gateway, on SKIP (pas de fallback vers caller).
 *
 * ✅ FIX 2 :
 *  - transactionId peut être un ObjectId Mongo (24 hex) => retrouver par _id aussi.
 */

const axios = require('axios');
const config = require('../src/config');
const logger = require('../src/logger');
const Transaction = require('../src/models/Transaction');
const AMLLog = require('../src/models/AMLLog');
const crypto = require('crypto');

const { notifyTransactionEvent } = require('../src/services/transactionNotificationService');

const {
  checkAndGenerateReferralCodeInMain,
  processReferralBonusIfEligible,
} = require('../src/utils/referralUtils');

const { notifyReferralOnConfirm } = require('../src/services/referralGatewayService');

const PRINCIPAL_URL = (config.principalUrl || process.env.PRINCIPAL_URL || '').replace(/\/+$/, '');
const ADMIN_USER_ID = config.adminUserId || process.env.ADMIN_USER_ID || null;

const PROVIDER_TO_SERVICE = {
  paynoval: config.microservices.paynoval,
  stripe: config.microservices.stripe,
  bank: config.microservices.bank,
  mobilemoney: config.microservices.mobilemoney,
  visa_direct: config.microservices.visa_direct,
  visadirect: config.microservices.visa_direct,
  cashin: config.microservices.cashin,
  cashout: config.microservices.cashout,
  stripe2momo: config.microservices.stripe2momo,
  flutterwave: config.microservices.flutterwave,
};

const GATEWAY_USER_AGENT =
  config.gatewayUserAgent || 'PayNoval-Gateway/1.0 (+https://paynoval.com)';

function safeUUID() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch (e) {}
  }
  return (
    Date.now().toString(16) +
    '-' +
    Math.floor(Math.random() * 0xffff).toString(16) +
    '-' +
    Math.floor(Math.random() * 0xffff).toString(16)
  );
}

function cleanSensitiveMeta(meta = {}) {
  const clone = { ...meta };
  if (clone.cardNumber) clone.cardNumber = '****' + String(clone.cardNumber).slice(-4);
  if (clone.cvc) delete clone.cvc;
  if (clone.securityCode) delete clone.securityCode;
  return clone;
}

function getUserId(req) {
  return req.user?._id || req.user?.id || null;
}

function resolveProvider(req, fallback = 'paynoval') {
  const body = req.body || {};
  const query = req.query || {};
  return req.routedProvider || body.provider || body.destination || query.provider || fallback;
}

/**
 * ✅ IMPORTANT:
 *  - On ne fallback JAMAIS sur le caller pour le parrainage.
 */
function resolveReferralOwnerUserId(txDoc) {
  return (
    txDoc?.ownerUserId ||
    txDoc?.initiatorUserId ||
    txDoc?.fromUserId ||
    txDoc?.senderId ||
    txDoc?.createdBy ||
    txDoc?.userId || // legacy
    null
  );
}

function auditForwardHeaders(req) {
  const incomingAuth = req.headers.authorization || req.headers.Authorization || null;

  const hasAuth =
    !!incomingAuth &&
    String(incomingAuth).toLowerCase() !== 'bearer null' &&
    String(incomingAuth).trim().toLowerCase() !== 'null';

  const reqId = req.headers['x-request-id'] || req.id || safeUUID();
  const userId = getUserId(req) || req.headers['x-user-id'] || '';

  const headers = {
    Accept: 'application/json',
    'x-internal-token': config.internalToken || '',
    'x-request-id': reqId,
    'x-user-id': userId,
    'x-session-id': req.headers['x-session-id'] || '',
    ...(req.headers['x-device-id'] ? { 'x-device-id': req.headers['x-device-id'] } : {}),
  };

  if (hasAuth) headers.Authorization = incomingAuth;

  try {
    const authPreview = headers.Authorization ? String(headers.Authorization).slice(0, 12) : null;
    logger.debug('[Gateway][AUDIT HEADERS] forwarding', {
      authPreview,
      xInternalToken: headers['x-internal-token'] ? 'present' : 'missing',
      requestId: reqId,
      userId,
      dest: req.path,
    });
  } catch (e) {}

  return headers;
}

function isCloudflareChallengeResponse(response) {
  if (!response) return false;
  const status = response.status;
  const data = response.data;

  if (!data || typeof data !== 'string') return false;
  const lower = data.toLowerCase();

  const looksLikeHtml = lower.includes('<html') || lower.includes('<!doctype html');

  const hasCloudflareMarkers =
    lower.includes('just a moment') ||
    lower.includes('attention required') ||
    lower.includes('cdn-cgi/challenge-platform') ||
    lower.includes('__cf_chl_') ||
    lower.includes('cloudflare');

  const suspiciousStatus = status === 403 || status === 429 || status === 503;

  return hasCloudflareMarkers && (suspiciousStatus || looksLikeHtml);
}

async function safeAxiosRequest(opts) {
  const finalOpts = { ...opts };

  if (!finalOpts.timeout) finalOpts.timeout = 15000;
  finalOpts.method = finalOpts.method || 'get';

  finalOpts.headers = { ...(finalOpts.headers || {}) };
  const hasUA = finalOpts.headers['User-Agent'] || finalOpts.headers['user-agent'];
  if (!hasUA) finalOpts.headers['User-Agent'] = GATEWAY_USER_AGENT;

  try {
    const response = await axios(finalOpts);

    if (isCloudflareChallengeResponse(response)) {
      const e = new Error('Cloudflare challenge détecté');
      e.response = response;
      e.isCloudflareChallenge = true;
      throw e;
    }

    return response;
  } catch (err) {
    const status = err.response?.status || 502;
    const data = err.response?.data || null;
    const message = err.message || 'Erreur axios inconnue';

    const preview = typeof data === 'string' ? data.slice(0, 300) : data;
    const isCf = err.isCloudflareChallenge || isCloudflareChallengeResponse(err.response);
    const isRateLimited = status === 429;

    logger.error('[Gateway][Axios] request failed', {
      url: finalOpts.url,
      method: finalOpts.method,
      status,
      isCloudflare: isCf,
      isRateLimited,
      dataPreview: preview,
      message,
    });

    const e = new Error(message);
    e.response = err.response;
    e.isCloudflareChallenge = isCf;
    e.isRateLimited = isRateLimited;
    throw e;
  }
}

function hashSecurityCode(code) {
  return crypto.createHash('sha256').update(String(code || '').trim()).digest('hex');
}

function looksLikeObjectId(v) {
  return typeof v === 'string' && /^[a-fA-F0-9]{24}$/.test(v);
}

/**
 * ✅ findGatewayTxForConfirm(provider, transactionId, body)
 * -> recherche par reference/meta + ✅ par _id si ObjectId
 */
async function findGatewayTxForConfirm(provider, transactionId, body = {}) {
  const candidates = Array.from(
    new Set(
      [
        transactionId,
        body.transactionId,
        body.reference,
        body.ref,
        body.id,
        body.txId,
        body._id,
      ]
        .filter(Boolean)
        .map((v) => String(v))
    )
  );

  if (!candidates.length) return null;

  const or = [];
  for (const c of candidates) {
    or.push({ reference: c });
    or.push({ 'meta.reference': c });
    or.push({ 'meta.id': c });
    if (looksLikeObjectId(c)) or.push({ _id: c });
  }

  return Transaction.findOne({ provider, $or: or });
}

async function creditAdminCommissionFromGateway({ provider, kind, amount, currency, req }) {
  try {
    if (!PRINCIPAL_URL || !ADMIN_USER_ID) {
      logger.warn('[Gateway][Fees] PRINCIPAL_URL ou ADMIN_USER_ID manquant, commission admin non créditée.');
      return;
    }

    const num = parseFloat(amount);
    if (!num || Number.isNaN(num) || num <= 0) return;

    const url = `${PRINCIPAL_URL}/users/${ADMIN_USER_ID}/credit`;

    const authHeader = req.headers.authorization || req.headers.Authorization || null;
    const headers = {};
    if (authHeader && String(authHeader).toLowerCase().startsWith('bearer ')) {
      headers.Authorization = authHeader;
    }

    const description = `Commission PayNoval (${kind}) - provider=${provider}`;

    await safeAxiosRequest({
      method: 'post',
      url,
      data: { amount: num, currency: currency || 'CAD', description },
      headers,
      timeout: 10000,
    });

    logger.info('[Gateway][Fees] Crédit admin OK', {
      provider,
      kind,
      amount: num,
      currency: currency || 'CAD',
      adminUserId: ADMIN_USER_ID,
    });
  } catch (err) {
    logger.error('[Gateway][Fees] Échec crédit admin', {
      provider,
      kind,
      amount,
      currency,
      message: err.message,
    });
  }
}

async function triggerGatewayTxEmail(type, { provider, req, result, reference }) {
  try {
    if (provider === 'paynoval') return;

    const user = req.user || {};
    const senderEmail = user.email || user.username || req.body.senderEmail || null;
    const senderName = user.fullName || user.name || req.body.senderName || senderEmail;

    const receiverEmail = result.receiverEmail || result.toEmail || req.body.toEmail || null;
    const receiverName = result.receiverName || req.body.receiverName || receiverEmail;

    if (!senderEmail && !receiverEmail) {
      logger.warn('[Gateway][TX] triggerGatewayTxEmail: aucun email sender/receiver, skip.');
      return;
    }

    const txId = result.transactionId || result.id || reference || null;
    const txReference = reference || result.reference || null;
    const amount = result.amount || req.body.amount || 0;

    const currency =
      result.currency ||
      req.body.currency ||
      req.body.senderCurrencySymbol ||
      req.body.localCurrencySymbol ||
      '---';

    const frontendBase =
      config.frontendUrl ||
      config.frontUrl ||
      (Array.isArray(config.cors?.origins) && config.cors.origins[0]) ||
      'https://www.paynoval.com';

    const payload = {
      type,
      provider,
      transaction: {
        id: txId,
        reference: txReference,
        amount,
        currency,
        dateIso: new Date().toISOString(),
      },
      sender: { email: senderEmail, name: senderName || senderEmail },
      receiver: { email: receiverEmail, name: receiverName || receiverEmail },
      reason: type === 'cancelled' ? result.reason || req.body.reason || '' : undefined,
      links: {
        sender: `${frontendBase}/transactions`,
        receiverConfirm: txId
          ? `${frontendBase}/transactions/confirm/${encodeURIComponent(txId)}`
          : '',
      },
    };

    await notifyTransactionEvent(payload);
    logger.info('[Gateway][TX] triggerGatewayTxEmail OK', { type, provider, txId, senderEmail, receiverEmail });
  } catch (err) {
    logger.error('[Gateway][TX] triggerGatewayTxEmail ERROR', { type, provider, message: err.message });
  }
}

/* -------------------------------------------------------------------
 *                       CONTROLLER ACTIONS
 * ------------------------------------------------------------------- */

exports.getTransaction = async (req, res) => {
  const provider = resolveProvider(req, 'paynoval');
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const { id } = req.params;
  const base = String(targetService).replace(/\/+$/, '');
  const url = `${base}/transactions/${encodeURIComponent(id)}`;

  try {
    const response = await safeAxiosRequest({
      method: 'get',
      url,
      headers: auditForwardHeaders(req),
      params: req.query,
      timeout: 10000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur GET transaction', {
        provider,
        transactionId: id,
        upstreamStatus: err.response?.status,
      });

      return res.status(503).json({
        success: false,
        error: 'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string' ? err.response.data : null) ||
      'Erreur lors du proxy GET transaction';

    if (status === 429) {
      error = 'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
    }

    logger.error('[Gateway][TX] Erreur GET transaction:', { status, error, provider, transactionId: id });
    return res.status(status).json({ success: false, error });
  }
};

exports.listTransactions = async (req, res) => {
  const provider = resolveProvider(req, 'paynoval');
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const base = String(targetService).replace(/\/+$/, '');
  const url = `${base}/transactions`;

  try {
    const response = await safeAxiosRequest({
      method: 'get',
      url,
      headers: auditForwardHeaders(req),
      params: req.query,
      timeout: 15000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur GET transactions', {
        provider,
        upstreamStatus: err.response?.status,
        path: '/transactions',
      });

      return res.status(503).json({
        success: false,
        error: 'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string' ? err.response.data : null) ||
      'Erreur lors du proxy GET transactions';

    if (status === 429) {
      error = 'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
    }

    logger.error('[Gateway][TX] Erreur GET transactions:', { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
};

/**
 * POST /transactions/initiate
 * ✅ On stocke ownerUserId/initiatorUserId (expéditeur) dès l'initiate.
 */
exports.initiateTransaction = async (req, res) => {
  const targetProvider = resolveProvider(req, 'paynoval');
  const targetService = PROVIDER_TO_SERVICE[targetProvider];
  const targetUrl = targetService ? String(targetService).replace(/\/+$/, '') + '/transactions/initiate' : null;

  logger.debug('[Gateway][TX] initiateTransaction targetUrl', { targetProvider, targetUrl });

  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'Provider (destination) inconnu.' });
  }

  const userId = getUserId(req);
  const now = new Date();
  let reference = null;
  let statusResult = 'pending';

  const securityQuestion = (req.body.securityQuestion || req.body.question || '').trim();
  const securityCode = (req.body.securityCode || '').trim();

  if (!securityQuestion || !securityCode) {
    return res.status(400).json({
      success: false,
      error: 'Question et code de sécurité obligatoires pour initier une transaction.',
    });
  }
  const securityCodeHash = hashSecurityCode(securityCode);

  try {
    const response = await safeAxiosRequest({
      method: 'post',
      url: targetUrl,
      data: req.body,
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    const result = response.data;
    reference = result.reference || result.id || null;
    statusResult = result.status || 'pending';

    await AMLLog.create({
      userId,
      type: 'initiate',
      provider: targetProvider,
      amount: req.body.amount,
      toEmail: req.body.toEmail || '',
      details: cleanSensitiveMeta(req.body),
      flagged: req.amlFlag || false,
      flagReason: req.amlReason || '',
      createdAt: now,
    });

    await Transaction.create({
      userId, // legacy compat
      ownerUserId: userId,
      initiatorUserId: userId,

      provider: targetProvider,
      amount: req.body.amount,
      status: statusResult,
      toEmail: req.body.toEmail || undefined,
      toIBAN: req.body.iban || undefined,
      toPhone: req.body.phoneNumber || undefined,
      currency:
        req.body.currency ||
        req.body.senderCurrencySymbol ||
        req.body.localCurrencySymbol ||
        undefined,
      operator: req.body.operator || undefined,
      country: req.body.country || undefined,
      reference,
      meta: cleanSensitiveMeta(req.body),
      createdAt: now,
      updatedAt: now,

      requiresSecurityValidation: true,
      securityQuestion,
      securityCodeHash,
      securityAttempts: 0,
      securityLockedUntil: null,
    });

    await triggerGatewayTxEmail('initiated', { provider: targetProvider, req, result, reference });

    if (targetProvider !== 'paynoval') {
      try {
        const rawFee = (result && (result.fees || result.fee || result.transactionFees)) || null;
        if (rawFee) {
          const feeAmount = parseFloat(rawFee);
          if (!Number.isNaN(feeAmount) && feeAmount > 0) {
            const feeCurrency =
              result.feeCurrency ||
              result.currency ||
              req.body.currency ||
              req.body.senderCurrencySymbol ||
              req.body.localCurrencySymbol ||
              'CAD';

            await creditAdminCommissionFromGateway({
              provider: targetProvider,
              kind: 'transaction',
              amount: feeAmount,
              currency: feeCurrency,
              req,
            });
          }
        } else {
          logger.debug('[Gateway][Fees] Aucun champ fees/fee/transactionFees, commission admin non calculée.', {
            provider: targetProvider,
          });
        }
      } catch (e) {
        logger.error('[Gateway][Fees] Erreur crédit admin (initiate)', { provider: targetProvider, message: e.message });
      }
    }

    return res.status(response.status).json(result);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur INITIATE', {
        provider: targetProvider,
        upstreamStatus: err.response?.status,
      });

      return res.status(503).json({
        success: false,
        error: 'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string' ? err.response.data : null) ||
      err.message ||
      'Erreur interne provider';

    if (status === 429) {
      error = 'Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.';
    }

    await AMLLog.create({
      userId,
      type: 'initiate',
      provider: targetProvider,
      amount: req.body.amount,
      toEmail: req.body.toEmail || '',
      details: cleanSensitiveMeta({ ...req.body, error }),
      flagged: req.amlFlag || false,
      flagReason: req.amlReason || '',
      createdAt: now,
    });

    await Transaction.create({
      userId,
      ownerUserId: userId,
      initiatorUserId: userId,

      provider: targetProvider,
      amount: req.body.amount,
      status: 'failed',
      toEmail: req.body.toEmail || undefined,
      toIBAN: req.body.iban || undefined,
      toPhone: req.body.phoneNumber || undefined,
      currency:
        req.body.currency ||
        req.body.senderCurrencySymbol ||
        req.body.localCurrencySymbol ||
        undefined,
      operator: req.body.operator || undefined,
      country: req.body.country || undefined,
      reference: null,
      meta: cleanSensitiveMeta({ ...req.body, error }),
      createdAt: now,
      updatedAt: now,
    });

    logger.error('[Gateway][TX] initiateTransaction failed', { provider: targetProvider, error, status });
    return res.status(status).json({ success: false, error });
  }
};

/**
 * POST /transactions/confirm
 * ✅ referralUserId = ownerUserId (expéditeur)
 * ✅ si owner introuvable => SKIP (pas de fallback vers caller)
 */
exports.confirmTransaction = async (req, res) => {
  const provider = resolveProvider(req, 'paynoval');
  const { transactionId, securityCode } = req.body;

  const targetService = PROVIDER_TO_SERVICE[provider];
  const targetUrl = targetService ? String(targetService).replace(/\/+$/, '') + '/transactions/confirm' : null;

  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'Provider (destination) inconnu.' });
  }

  const confirmCallerUserId = getUserId(req); // ⚠️ souvent destinataire
  const now = new Date();

  // ✅ Précharge txRecord pour obtenir ownerUserId de manière fiable
  let txRecord = await findGatewayTxForConfirm(provider, transactionId, req.body);

  const normalizeStatus = (raw) => {
    const s = String(raw || '').toLowerCase().trim();
    if (s === 'cancelled' || s === 'canceled') return 'canceled';
    if (s === 'confirmed' || s === 'success' || s === 'validated' || s === 'completed') return 'confirmed';
    if (s === 'failed' || s === 'error' || s === 'declined' || s === 'rejected') return 'failed';
    if (s === 'pending' || s === 'processing' || s === 'in_progress') return 'pending';
    return s || 'confirmed';
  };

  // 1) Couche de sécurité côté Gateway (providers ≠ paynoval)
  if (provider !== 'paynoval') {
    if (!txRecord) {
      const strict = await Transaction.findOne({ provider, reference: String(transactionId) });
      if (strict) txRecord = strict;
    }

    if (!txRecord) {
      return res.status(404).json({ success: false, error: 'Transaction non trouvée dans le Gateway.' });
    }

    if (txRecord.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Transaction déjà traitée ou annulée.' });
    }

    if (txRecord.requiresSecurityValidation && txRecord.securityCodeHash) {
      if (txRecord.securityLockedUntil && txRecord.securityLockedUntil > now) {
        return res.status(423).json({
          success: false,
          error: 'Transaction temporairement bloquée suite à des tentatives infructueuses. Réessayez plus tard.',
        });
      }

      if (!securityCode) {
        return res.status(400).json({
          success: false,
          error: 'securityCode requis pour confirmer cette transaction.',
        });
      }

      const incomingHash = hashSecurityCode(securityCode);

      if (incomingHash !== txRecord.securityCodeHash) {
        const attempts = (txRecord.securityAttempts || 0) + 1;

        const update = { securityAttempts: attempts, updatedAt: now };
        let errorMsg;

        if (attempts >= 3) {
          update.status = 'canceled';
          update.cancelledAt = now;
          update.cancelReason = 'Code de sécurité erroné (trop d’essais)';
          update.securityLockedUntil = new Date(now.getTime() + 15 * 60 * 1000);

          errorMsg = 'Code de sécurité incorrect. Nombre d’essais dépassé, transaction annulée.';

          await triggerGatewayTxEmail('cancelled', {
            provider,
            req,
            result: {
              ...txRecord.toObject(),
              status: 'canceled',
              amount: txRecord.amount,
              toEmail: txRecord.toEmail,
            },
            reference: transactionId,
          });
        } else {
          const remaining = 3 - attempts;
          errorMsg = `Code de sécurité incorrect. Il vous reste ${remaining} essai(s).`;
        }

        await Transaction.updateOne({ _id: txRecord._id }, { $set: update });
        return res.status(401).json({ success: false, error: errorMsg });
      }

      await Transaction.updateOne(
        { _id: txRecord._id },
        {
          $set: {
            securityAttempts: 0,
            securityLockedUntil: null,
            updatedAt: now,
          },
        }
      );
    }
  }

  // 2) Appel au provider + update gateway
  try {
    const response = await safeAxiosRequest({
      method: 'post',
      url: targetUrl,
      data: req.body,
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    const result = response.data;
    const newStatus = normalizeStatus(result.status || 'confirmed');

    const refFromResult = result.reference || result.transaction?.reference || req.body.reference || null;
    const idFromResult = result.id || result.transaction?.id || transactionId || null;

    const candidates = Array.from(new Set([refFromResult, idFromResult, transactionId].filter(Boolean).map(String)));

    let query = { provider };
    if (candidates.length > 0) {
      const or = [];
      for (const v of candidates) {
        or.push({ reference: v }, { 'meta.reference': v }, { 'meta.id': v });
        if (looksLikeObjectId(v)) or.push({ _id: v });
      }
      query = { provider, $or: or };
    }

    // 3) AML log confirm (caller)
    await AMLLog.create({
      userId: confirmCallerUserId,
      type: 'confirm',
      provider,
      amount: result.amount || 0,
      toEmail: result.recipientEmail || result.toEmail || result.email || '',
      details: cleanSensitiveMeta(req.body),
      flagged: false,
      flagReason: '',
      createdAt: now,
    });

    // 4) Update Transaction Gateway + récup du doc (priorité _id)
    let gatewayTx = null;

    if (txRecord?._id) {
      gatewayTx = await Transaction.findByIdAndUpdate(
        txRecord._id,
        {
          $set: {
            status: newStatus,
            confirmedAt: newStatus === 'confirmed' ? now : undefined,
            cancelledAt: newStatus === 'canceled' ? now : undefined,
            updatedAt: now,
          },
        },
        { new: true }
      );
    } else {
      gatewayTx = await Transaction.findOneAndUpdate(
        query,
        {
          $set: {
            status: newStatus,
            confirmedAt: newStatus === 'confirmed' ? now : undefined,
            cancelledAt: newStatus === 'canceled' ? now : undefined,
            updatedAt: now,
          },
        },
        { new: true }
      );
    }

    if (!gatewayTx) {
      logger.warn('[Gateway][TX] confirmTransaction: aucune transaction Gateway trouvée à mettre à jour', {
        provider,
        transactionId,
        refFromResult,
        candidates,
      });
    }

    // ✅ Backfill ownerUserId si absent mais userId présent (legacy)
    if (gatewayTx && !gatewayTx.ownerUserId && gatewayTx.userId) {
      try {
        await Transaction.updateOne(
          { _id: gatewayTx._id, ownerUserId: { $exists: false } },
          { $set: { ownerUserId: gatewayTx.userId, initiatorUserId: gatewayTx.userId } }
        );
        gatewayTx.ownerUserId = gatewayTx.userId;
        gatewayTx.initiatorUserId = gatewayTx.userId;
      } catch (e) {}
    }

    // 5) Email selon statut final
    if (newStatus === 'confirmed') {
      await triggerGatewayTxEmail('confirmed', { provider, req, result, reference: refFromResult || transactionId });
    } else if (newStatus === 'canceled') {
      await triggerGatewayTxEmail('cancelled', { provider, req, result, reference: refFromResult || transactionId });
    } else if (newStatus === 'failed') {
      await triggerGatewayTxEmail('failed', { provider, req, result, reference: refFromResult || transactionId });
    }

    // 6) PARRAINAGE (SEULEMENT SI CONFIRMÉ)
    if (newStatus === 'confirmed') {
      const referralUserId = resolveReferralOwnerUserId(gatewayTx || txRecord);

      if (!referralUserId) {
        logger.warn('[Gateway][TX][Referral] owner introuvable => SKIP (évite attribution au destinataire)', {
          provider,
          transactionId,
          gatewayTxId: gatewayTx?._id,
          confirmCallerUserId,
        });
      } else {
        try {
          const txIdSafe = result.id || result.transaction?.id || transactionId || null;
          const refSafe = result.reference || result.transaction?.reference || transactionId || null;

          const txForReferral = {
            id: String(txIdSafe || refSafe || ''),
            reference: refSafe ? String(refSafe) : '',
            status: 'confirmed',
            amount: Number(result.amount || gatewayTx?.amount || txRecord?.amount || 0),
            currency: String(
              result.currency ||
                gatewayTx?.currency ||
                txRecord?.currency ||
                req.body.currency ||
                'CAD'
            ),
            country: String(result.country || gatewayTx?.country || txRecord?.country || req.body.country || ''),
            provider: String(provider),
            createdAt: (gatewayTx?.createdAt || txRecord?.createdAt)
              ? new Date(gatewayTx?.createdAt || txRecord?.createdAt).toISOString()
              : new Date().toISOString(),
            confirmedAt: new Date().toISOString(),
          };

          await checkAndGenerateReferralCodeInMain(referralUserId, null, txForReferral);
          await processReferralBonusIfEligible(referralUserId, null);
        } catch (e) {
          logger.warn('[Gateway][TX][Referral] parrainage failed', { referralUserId, message: e?.message });
        }

        try {
          const txIdSafe = result.id || result.transaction?.id || transactionId || null;
          const refSafe = result.reference || result.transaction?.reference || transactionId || null;

          await notifyReferralOnConfirm({
            userId: referralUserId,
            provider,
            transaction: {
              id: String(txIdSafe || refSafe || ''),
              reference: refSafe ? String(refSafe) : '',
              amount: Number(result.amount || gatewayTx?.amount || txRecord?.amount || 0),
              currency: String(
                result.currency ||
                  gatewayTx?.currency ||
                  txRecord?.currency ||
                  req.body.currency ||
                  'CAD'
              ),
              country: String(result.country || gatewayTx?.country || txRecord?.country || req.body.country || ''),
              provider: String(provider),
              confirmedAt: new Date().toISOString(),
            },
            requestId: req.id,
          });
        } catch (e) {
          logger.warn('[Gateway][Referral] notifyReferralOnConfirm failed', { message: e?.message });
        }
      }
    }

    return res.status(response.status).json(result);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur CONFIRM', {
        provider,
        upstreamStatus: err.response?.status,
      });

      return res.status(503).json({
        success: false,
        error: 'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string' ? err.response.data : null) ||
      err.message ||
      'Erreur interne provider';

    if (status === 429) {
      error = 'Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.';
    }

    await AMLLog.create({
      userId: confirmCallerUserId,
      type: 'confirm',
      provider,
      amount: 0,
      toEmail: '',
      details: cleanSensitiveMeta({ ...req.body, error }),
      flagged: false,
      flagReason: '',
      createdAt: now,
    });

    // ✅ update fail : support _id
    const or = [
      { reference: String(transactionId) },
      { 'meta.reference': String(transactionId) },
      { 'meta.id': String(transactionId) },
    ];
    if (looksLikeObjectId(String(transactionId))) or.push({ _id: String(transactionId) });

    await Transaction.findOneAndUpdate(
      { provider, $or: or },
      { $set: { status: 'failed', updatedAt: now } }
    );

    logger.error('[Gateway][TX] confirmTransaction failed', { provider, error, status });
    return res.status(status).json({ success: false, error });
  }
};

/**
 * POST /transactions/cancel
 */
exports.cancelTransaction = async (req, res) => {
  const provider = resolveProvider(req, 'paynoval');
  const { transactionId } = req.body;

  const targetService = PROVIDER_TO_SERVICE[provider];
  const targetUrl = targetService ? String(targetService).replace(/\/+$/, '') + '/transactions/cancel' : null;

  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'Provider (destination) inconnu.' });
  }

  const userId = getUserId(req);
  const now = new Date();

  try {
    const response = await safeAxiosRequest({
      method: 'post',
      url: targetUrl,
      data: req.body,
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    const result = response.data;
    const newStatus = result.status || 'canceled';

    await AMLLog.create({
      userId,
      type: 'cancel',
      provider,
      amount: result.amount || 0,
      toEmail: result.toEmail || '',
      details: cleanSensitiveMeta(req.body),
      flagged: false,
      flagReason: '',
      createdAt: now,
    });

    const or = [
      { reference: String(transactionId) },
      { 'meta.reference': String(transactionId) },
      { 'meta.id': String(transactionId) },
    ];
    if (looksLikeObjectId(String(transactionId))) or.push({ _id: String(transactionId) });

    await Transaction.findOneAndUpdate(
      { provider, $or: or },
      {
        $set: {
          status: newStatus,
          cancelledAt: now,
          cancelReason: req.body.reason || result.reason || '',
          updatedAt: now,
        },
      }
    );

    await triggerGatewayTxEmail('cancelled', { provider, req, result, reference: transactionId });

    if (provider !== 'paynoval') {
      try {
        const rawCancellationFee =
          result.cancellationFeeInSenderCurrency || result.cancellationFee || result.fees || null;

        if (rawCancellationFee) {
          const feeAmount = parseFloat(rawCancellationFee);
          if (!Number.isNaN(feeAmount) && feeAmount > 0) {
            const feeCurrency =
              result.adminCurrency ||
              result.currency ||
              req.body.currency ||
              req.body.senderCurrencySymbol ||
              'CAD';

            await creditAdminCommissionFromGateway({
              provider,
              kind: 'cancellation',
              amount: feeAmount,
              currency: feeCurrency,
              req,
            });
          }
        } else {
          logger.debug('[Gateway][Fees] Aucun champ cancellationFee*/fees, pas de commission admin.', { provider });
        }
      } catch (e) {
        logger.error('[Gateway][Fees] Erreur crédit admin (cancel)', { provider, message: e.message });
      }
    }

    return res.status(response.status).json(result);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur CANCEL', {
        provider,
        upstreamStatus: err.response?.status,
      });

      return res.status(503).json({
        success: false,
        error: 'Service de paiement temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string' ? err.response.data : null) ||
      err.message ||
      'Erreur interne provider';

    if (status === 429) {
      error = 'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
    }

    await AMLLog.create({
      userId,
      type: 'cancel',
      provider,
      amount: 0,
      toEmail: '',
      details: cleanSensitiveMeta({ ...req.body, error }),
      flagged: false,
      flagReason: '',
      createdAt: now,
    });

    const or = [
      { reference: String(transactionId) },
      { 'meta.reference': String(transactionId) },
      { 'meta.id': String(transactionId) },
    ];
    if (looksLikeObjectId(String(transactionId))) or.push({ _id: String(transactionId) });

    await Transaction.findOneAndUpdate(
      { provider, $or: or },
      { $set: { status: 'failed', updatedAt: now } }
    );

    logger.error('[Gateway][TX] cancelTransaction failed', { provider, error, status });
    return res.status(status).json({ success: false, error });
  }
};

/**
 * POST /transactions/internal/log
 */
exports.logInternalTransaction = async (req, res) => {
  try {
    const headerToken = req.headers['x-internal-token'] || '';
    const expectedToken = config.internalToken || process.env.INTERNAL_LOG_TOKEN || '';

    if (expectedToken && headerToken !== expectedToken) {
      logger.warn('[Gateway][TX] logInternalTransaction: token interne invalide');
      return res.status(401).json({ success: false, error: 'Appel interne non autorisé.' });
    }

    const now = new Date();
    const userId = getUserId(req) || req.body.userId;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId manquant pour loguer la transaction.' });
    }

    const {
      provider = 'paynoval',
      amount,
      status = 'confirmed',
      currency,
      operator = 'paynoval',
      country,
      reference,
      meta = {},
      createdBy,
      receiver,
      fees,
      netAmount,
      ownerUserId,
      initiatorUserId,
      recipientInfo,
    } = req.body || {};

    const numAmount = Number(amount);
    if (!numAmount || Number.isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, error: 'amount invalide ou manquant pour loguer la transaction.' });
    }

    const tx = await Transaction.create({
      userId,
      ownerUserId: ownerUserId || initiatorUserId || createdBy || userId,
      initiatorUserId: initiatorUserId || ownerUserId || createdBy || userId,

      provider,
      amount: numAmount,
      status,
      currency,
      operator,
      country,
      reference,
      requiresSecurityValidation: false,
      securityAttempts: 0,
      securityLockedUntil: null,
      confirmedAt: status === 'confirmed' ? now : undefined,
      meta: cleanSensitiveMeta(meta),
      recipientInfo: recipientInfo || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: createdBy || userId,
      receiver: receiver || userId,
      fees: typeof fees === 'number' ? fees : undefined,
      netAmount: typeof netAmount === 'number' ? netAmount : undefined,
    });

    return res.status(201).json({ success: true, data: tx });
  } catch (err) {
    logger.error('[Gateway][TX] logInternalTransaction error', { message: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      error: 'Erreur lors de la création de la transaction interne.',
    });
  }
};

exports.refundTransaction = async (req, res) => forwardTransactionProxy(req, res, 'refund');
exports.reassignTransaction = async (req, res) => forwardTransactionProxy(req, res, 'reassign');
exports.validateTransaction = async (req, res) => forwardTransactionProxy(req, res, 'validate');
exports.archiveTransaction = async (req, res) => forwardTransactionProxy(req, res, 'archive');
exports.relaunchTransaction = async (req, res) => forwardTransactionProxy(req, res, 'relaunch');

async function forwardTransactionProxy(req, res, action) {
  const provider = resolveProvider(req, 'paynoval');
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const url = String(targetService).replace(/\/+$/, '') + `/transactions/${action}`;

  try {
    const response = await safeAxiosRequest({
      method: 'post',
      url,
      data: req.body,
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur action', {
        provider,
        action,
        upstreamStatus: err.response?.status,
      });

      return res.status(503).json({
        success: false,
        error: 'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string' ? err.response.data : null) ||
      err.message ||
      `Erreur proxy ${action}`;

    if (status === 429) {
      error = 'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
    }

    logger.error(`[Gateway][TX] Erreur ${action}:`, { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
}
