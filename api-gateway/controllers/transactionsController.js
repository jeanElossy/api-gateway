// "use strict";

// /**
//  * -------------------------------------------------------------------
//  * CONTROLLER TRANSACTIONS (API GATEWAY)
//  * -------------------------------------------------------------------
//  * PATCH FLOW UNIFIÉ (2026-01) :
//  * ✅ Ajout routing "providerSelected" :
//  *    - deposit  => providerSelected = funds
//  *    - withdraw => providerSelected = destination
//  *    - send     => providerSelected = destination
//  *
//  * ✅ validateTransaction middleware met:
//  *    - req.providerSelected
//  *    - req.routedProvider = req.providerSelected
//  *    - req.body.action normalisée
//  *    - req.body.provider normalisée (compat)
//  */

// const axios = require("axios");
// const crypto = require("crypto");
// const config = require("../src/config");
// const logger = require("../src/logger");
// const Transaction = require("../src/models/Transaction");
// const AMLLog = require("../src/models/AMLLog");

// const mongoose = require("mongoose");

// // ⬇️ Service d’email transactionnel centralisé
// const { notifyTransactionEvent } = require("../src/services/transactionNotificationService");

// // ⬇️ Utilitaires de parrainage (logique programme)
// const { checkAndGenerateReferralCodeInMain, processReferralBonusIfEligible } = require("../src/utils/referralUtils");

// // ⬇️ Service gateway -> backend principal (route interne) pour "assurer" la génération du code
// const { notifyReferralOnConfirm } = require("../src/services/referralGatewayService");


// const TrustedDepositNumber = require("../src/models/TrustedDepositNumber");


// // ✅ Dial codes + tailles locales (fallback simple)
// const COUNTRY_DIAL = {
//   CI: { dial: "+225", localMin: 8, localMax: 10 },
//   BF: { dial: "+226", localMin: 8, localMax: 8 },
//   ML: { dial: "+223", localMin: 8, localMax: 8 },
//   CM: { dial: "+237", localMin: 8, localMax: 9 },
//   SN: { dial: "+221", localMin: 9, localMax: 9 },
//   BJ: { dial: "+229", localMin: 8, localMax: 8 },
//   TG: { dial: "+228", localMin: 8, localMax: 8 },
// };



// function digitsOnly(v) {
//   return String(v || "").replace(/[^\d]/g, "");
// }

// function normalizePhoneE164(rawPhone, country) {
//   const raw = String(rawPhone || "").trim().replace(/\s+/g, "");
//   if (!raw) return "";

//   if (raw.startsWith("+")) {
//     const d = "+" + digitsOnly(raw);
//     if (d.length < 8 || d.length > 16) return "";
//     return d;
//   }

//   const c = String(country || "").toUpperCase().trim();
//   const cfg = COUNTRY_DIAL[c];
//   if (!cfg) return "";

//   const d = digitsOnly(raw);
//   if (!d) return "";

//   if (d.length < cfg.localMin || d.length > cfg.localMax) return "";
//   return cfg.dial + d;
// }

// function pickUserPrimaryPhoneE164(user, countryFallback) {
//   if (!user) return "";

//   const direct =
//     user.phoneE164 || user.phoneNumber || user.phone || user.mobile || "";

//   const ctry = user.country || countryFallback || "";
//   let e164 = normalizePhoneE164(direct, ctry);
//   if (e164) return e164;

//   if (Array.isArray(user.mobiles)) {
//     const mm = user.mobiles.find((m) => m && (m.e164 || m.numero));
//     if (mm) {
//       e164 = normalizePhoneE164(mm.e164 || mm.numero, mm.country || ctry);
//       if (e164) return e164;
//     }
//   }

//   return "";
// }

// // ---- helper: base url (pour appeler /api/v1/phone-verification/status)
// function getBaseUrlFromReq(req) {
//   const envBase =
//     process.env.GATEWAY_URL ||
//     process.env.APP_BASE_URL ||
//     process.env.GATEWAY_BASE_URL ||
//     "";
//   if (envBase) return String(envBase).replace(/\/+$/, "");

//   const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
//     .split(",")[0]
//     .trim();
//   const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
//     .split(",")[0]
//     .trim();
//   if (!host) return "";
//   return `${proto}://${host}`.replace(/\/+$/, "");
// }

// async function fetchOtpStatus({ req, phoneE164, country }) {
//   // ✅ On suit ta demande : utilise /api/v1/phone-verification/status
//   const base = getBaseUrlFromReq(req);
//   if (!base) return { ok: false, trusted: false, status: "unknown" };

//   const url = `${base}/api/v1/phone-verification/status`;

//   try {
//     const r = await safeAxiosRequest({
//       method: "get",
//       url,
//       params: { phoneNumber: phoneE164, country },
//       headers: auditForwardHeaders(req),
//       timeout: 8000,
//     });

//     const payload = r?.data || {};
//     const data = payload?.data || payload;

//     const status = String(data?.status || "none").toLowerCase();
//     const trusted = !!data?.trusted || status === "trusted";

//     return { ok: true, trusted, status, data };
//   } catch (e) {
//     logger?.warn?.("[Gateway][OTP] status call failed", { message: e?.message });
//     return { ok: false, trusted: false, status: "unknown" };
//   }
// }





// // 🌐 Backend principal (API Users / Wallet / Notifications)
// const PRINCIPAL_URL = (config.principalUrl || process.env.PRINCIPAL_URL || "").replace(/\/+$/, "");

// // 🧑‍💼 ID MongoDB de l’admin (admin@paynoval.com) – à configurer en ENV
// const ADMIN_USER_ID = config.adminUserId || process.env.ADMIN_USER_ID || null;

// /**
//  * Mapping centralisé des providers -> service URL
//  */
// const PROVIDER_TO_SERVICE = {
//   paynoval: config.microservices.paynoval,
//   stripe: config.microservices.stripe,
//   bank: config.microservices.bank,
//   mobilemoney: config.microservices.mobilemoney,
//   visa_direct: config.microservices.visa_direct,
//   visadirect: config.microservices.visa_direct,
//   cashin: config.microservices.cashin,
//   cashout: config.microservices.cashout,
//   stripe2momo: config.microservices.stripe2momo,
//   flutterwave: config.microservices.flutterwave,
// };

// function isValidObjectId(v) {
//   if (!v) return false;
//   return mongoose.Types.ObjectId.isValid(v) && String(v).length === 24;
// }

// function asObjectIdOrNull(v) {
//   if (!v) return null;
//   if (isValidObjectId(v)) return v;
//   return null;
// }

// // User-Agent par défaut pour tous les appels sortants du Gateway
// const GATEWAY_USER_AGENT = config.gatewayUserAgent || "PayNoval-Gateway/1.0 (+https://paynoval.com)";

// function safeUUID() {
//   if (crypto && typeof crypto.randomUUID === "function") {
//     try {
//       return crypto.randomUUID();
//     } catch {}
//   }
//   return (
//     Date.now().toString(16) +
//     "-" +
//     Math.floor(Math.random() * 0xffff).toString(16) +
//     "-" +
//     Math.floor(Math.random() * 0xffff).toString(16)
//   );
// }

// function cleanSensitiveMeta(meta = {}) {
//   const clone = { ...meta };
//   if (clone.cardNumber) clone.cardNumber = "****" + String(clone.cardNumber).slice(-4);
//   if (clone.cvc) delete clone.cvc;
//   if (clone.securityCode) delete clone.securityCode;
//   return clone;
// }

// function getUserId(req) {
//   return req.user?._id || req.user?.id || null;
// }

// /**
//  * ✅ computeProviderSelected(action,funds,destination)
//  * (Le middleware le fait déjà, mais on garde un fallback sécurité ici)
//  */
// function computeProviderSelected(action, funds, destination) {
//   const a = String(action || "").toLowerCase().trim();
//   const f = String(funds || "").toLowerCase().trim();
//   const d = String(destination || "").toLowerCase().trim();

//   if (a === "deposit") return f;
//   if (a === "withdraw") return d;
//   return d; // send default
// }

// function resolveProvider(req, fallback = "paynoval") {
//   const body = req.body || {};
//   const query = req.query || {};

//   // ✅ priorité au routing calculé par validateTransaction
//   const routed = req.routedProvider || req.providerSelected;
//   if (routed) return routed;

//   // compat: ancien comportement
//   return body.provider || body.destination || query.provider || fallback;
// }

// function toIdStr(v) {
//   if (!v) return "";
//   try {
//     if (typeof v === "string") return v;
//     if (typeof v === "object" && v.toString) return v.toString();
//   } catch {}
//   return String(v);
// }

// function sameId(a, b) {
//   const as = toIdStr(a);
//   const bs = toIdStr(b);
//   return !!as && !!bs && as === bs;
// }

// /**
//  * ✅ Resolver STRICT du propriétaire du referral.
//  */
// function resolveReferralOwnerUserId(txDoc, confirmCallerUserId = null) {
//   if (!txDoc) return null;

//   const candidates = [
//     txDoc.ownerUserId,
//     txDoc.initiatorUserId,
//     txDoc.fromUserId,
//     txDoc.senderId,
//     txDoc?.meta?.ownerUserId,
//     txDoc?.meta?.initiatorUserId,
//     txDoc?.meta?.fromUserId,
//     txDoc?.meta?.senderId,
//   ].filter(Boolean);

//   if (!candidates.length) return null;

//   const chosen = candidates[0];
//   if (!confirmCallerUserId) return chosen;

//   if (txDoc.receiver && sameId(txDoc.receiver, confirmCallerUserId) && sameId(chosen, confirmCallerUserId)) {
//     const alt = candidates.find((c) => !sameId(c, confirmCallerUserId));
//     return alt || null;
//   }

//   return chosen;
// }

// function auditForwardHeaders(req) {
//   const incomingAuth = req.headers.authorization || req.headers.Authorization || null;

//   const hasAuth =
//     !!incomingAuth &&
//     String(incomingAuth).toLowerCase() !== "bearer null" &&
//     String(incomingAuth).trim().toLowerCase() !== "null";

//   const reqId = req.headers["x-request-id"] || req.id || safeUUID();
//   const userId = getUserId(req) || req.headers["x-user-id"] || "";

//   const internalToken =
//     process.env.GATEWAY_INTERNAL_TOKEN || process.env.INTERNAL_TOKEN || config.internalToken || "";

//   const headers = {
//     Accept: "application/json",
//     "x-internal-token": internalToken,
//     "x-request-id": reqId,
//     "x-user-id": userId,
//     "x-session-id": req.headers["x-session-id"] || "",
//     ...(req.headers["x-device-id"] ? { "x-device-id": req.headers["x-device-id"] } : {}),
//   };

//   if (hasAuth) headers.Authorization = incomingAuth;

//   try {
//     const authPreview = headers.Authorization ? String(headers.Authorization).slice(0, 12) : null;
//     logger.debug("[Gateway][AUDIT HEADERS] forwarding", {
//       authPreview,
//       xInternalToken: headers["x-internal-token"] ? "present" : "missing",
//       requestId: reqId,
//       userId,
//       dest: req.path,
//     });
//   } catch {}

//   return headers;
// }

// function isCloudflareChallengeResponse(response) {
//   if (!response) return false;
//   const status = response.status;
//   const data = response.data;

//   if (!data || typeof data !== "string") return false;
//   const lower = data.toLowerCase();

//   const looksLikeHtml = lower.includes("<html") || lower.includes("<!doctype html");

//   const hasCloudflareMarkers =
//     lower.includes("just a moment") ||
//     lower.includes("attention required") ||
//     lower.includes("cdn-cgi/challenge-platform") ||
//     lower.includes("__cf_chl_") ||
//     lower.includes("cloudflare");

//   const suspiciousStatus = status === 403 || status === 429 || status === 503;

//   return hasCloudflareMarkers && (suspiciousStatus || looksLikeHtml);
// }

// async function safeAxiosRequest(opts) {
//   const finalOpts = { ...opts };

//   if (!finalOpts.timeout) finalOpts.timeout = 15000;
//   finalOpts.method = finalOpts.method || "get";

//   finalOpts.headers = { ...(finalOpts.headers || {}) };
//   const hasUA = finalOpts.headers["User-Agent"] || finalOpts.headers["user-agent"];
//   if (!hasUA) finalOpts.headers["User-Agent"] = GATEWAY_USER_AGENT;

//   try {
//     const response = await axios(finalOpts);

//     if (isCloudflareChallengeResponse(response)) {
//       const e = new Error("Cloudflare challenge détecté");
//       e.response = response;
//       e.isCloudflareChallenge = true;
//       throw e;
//     }

//     return response;
//   } catch (err) {
//     const status = err.response?.status || 502;
//     const data = err.response?.data || null;
//     const message = err.message || "Erreur axios inconnue";

//     const preview = typeof data === "string" ? data.slice(0, 300) : data;
//     const isCf = err.isCloudflareChallenge || isCloudflareChallengeResponse(err.response);
//     const isRateLimited = status === 429;

//     logger.error("[Gateway][Axios] request failed", {
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

// /* -------------------------------------------------------------------
//  *           ✅ SECURITY CODE HASHING (LEGACY + PBKDF2)
//  * ------------------------------------------------------------------- */

// // ✅ Legacy SHA256 (compat)
// function hashSecurityCodeLegacy(code) {
//   return crypto.createHash("sha256").update(String(code || "").trim()).digest("hex");
// }
// function isLegacySha256Hex(stored) {
//   return /^[a-f0-9]{64}$/i.test(String(stored || ""));
// }

// // ✅ Nouveau format: pbkdf2$<iter>$<saltB64>$<hashB64>
// function hashSecurityCodePBKDF2(code) {
//   const iterations = 180000;
//   const salt = crypto.randomBytes(16);
//   const derived = crypto.pbkdf2Sync(String(code || "").trim(), salt, iterations, 32, "sha256");
//   return `pbkdf2$${iterations}$${salt.toString("base64")}$${derived.toString("base64")}`;
// }

// function verifyPBKDF2(code, stored) {
//   try {
//     const [alg, iterStr, saltB64, hashB64] = String(stored || "").split("$");
//     if (alg !== "pbkdf2") return false;
//     const iterations = parseInt(iterStr, 10);
//     if (!Number.isFinite(iterations) || iterations < 10000) return false;

//     const salt = Buffer.from(saltB64, "base64");
//     const expected = Buffer.from(hashB64, "base64");
//     const computed = crypto.pbkdf2Sync(String(code || "").trim(), salt, iterations, expected.length, "sha256");

//     return expected.length === computed.length && crypto.timingSafeEqual(computed, expected);
//   } catch {
//     return false;
//   }
// }

// function verifySecurityCode(code, storedHash) {
//   const stored = String(storedHash || "");
//   if (!stored) return false;

//   if (stored.startsWith("pbkdf2$")) return verifyPBKDF2(code, stored);

//   if (isLegacySha256Hex(stored)) {
//     const computed = hashSecurityCodeLegacy(code);
//     return (
//       Buffer.byteLength(computed) === Buffer.byteLength(stored.toLowerCase()) &&
//       crypto.timingSafeEqual(Buffer.from(computed, "utf8"), Buffer.from(stored.toLowerCase(), "utf8"))
//     );
//   }

//   return false;
// }

// function hashSecurityCode(code) {
//   return hashSecurityCodePBKDF2(code);
// }

// /**
//  * ✅ Match robuste: reference + providerTxId + meta.*
//  */
// async function findGatewayTxForConfirm(provider, transactionId, body = {}) {
//   const candidates = Array.from(
//     new Set(
//       [
//         transactionId,
//         body.transactionId,
//         body.reference,
//         body.ref,
//         body.id,
//         body.txId,
//         body.providerTxId,
//       ]
//         .filter(Boolean)
//         .map((v) => String(v))
//     )
//   );

//   if (!candidates.length) return null;

//   return Transaction.findOne({
//     provider,
//     $or: [
//       ...candidates.map((v) => ({ reference: v })),
//       ...candidates.map((v) => ({ providerTxId: v })),
//       ...candidates.map((v) => ({ "meta.reference": v })),
//       ...candidates.map((v) => ({ "meta.id": v })),
//       ...candidates.map((v) => ({ "meta.providerTxId": v })),
//     ],
//   }).sort({ createdAt: -1 });
// }

// async function fetchProviderTxIdentifiers({ base, req, providerTxId }) {
//   if (!base || !providerTxId) return { providerTxId: null, reference: null };

//   try {
//     const getResp = await safeAxiosRequest({
//       method: "get",
//       url: `${base}/transactions/${encodeURIComponent(String(providerTxId))}`,
//       headers: auditForwardHeaders(req),
//       timeout: 10000,
//     });

//     const full = getResp.data?.data || getResp.data || {};
//     const fullRef = full.reference || full.transaction?.reference || null;
//     const fullId = full.id || full._id || full.transaction?.id || providerTxId || null;

//     return {
//       providerTxId: fullId ? String(fullId) : String(providerTxId),
//       reference: fullRef ? String(fullRef) : null,
//     };
//   } catch (e) {
//     logger.warn("[Gateway][TX] fetchProviderTxIdentifiers failed", {
//       providerTxId: String(providerTxId),
//       message: e?.message,
//     });
//     return { providerTxId: String(providerTxId), reference: null };
//   }
// }

// async function creditAdminCommissionFromGateway({ provider, kind, amount, currency, req }) {
//   try {
//     if (!PRINCIPAL_URL || !ADMIN_USER_ID) {
//       logger.warn("[Gateway][Fees] PRINCIPAL_URL ou ADMIN_USER_ID manquant, commission admin non créditée.");
//       return;
//     }

//     const num = parseFloat(amount);
//     if (!num || Number.isNaN(num) || num <= 0) return;

//     const url = `${PRINCIPAL_URL}/users/${ADMIN_USER_ID}/credit`;

//     const authHeader = req.headers.authorization || req.headers.Authorization || null;
//     const headers = {};
//     if (authHeader && String(authHeader).toLowerCase().startsWith("bearer ")) {
//       headers.Authorization = authHeader;
//     }

//     const description = `Commission PayNoval (${kind}) - provider=${provider}`;

//     await safeAxiosRequest({
//       method: "post",
//       url,
//       data: { amount: num, currency: currency || "CAD", description },
//       headers,
//       timeout: 10000,
//     });

//     logger.info("[Gateway][Fees] Crédit admin OK", {
//       provider,
//       kind,
//       amount: num,
//       currency: currency || "CAD",
//       adminUserId: ADMIN_USER_ID,
//     });
//   } catch (err) {
//     logger.error("[Gateway][Fees] Échec crédit admin", {
//       provider,
//       kind,
//       amount,
//       currency,
//       message: err.message,
//     });
//   }
// }

// async function triggerGatewayTxEmail(type, { provider, req, result, reference }) {
//   try {
//     if (provider === "paynoval") return;

//     const user = req.user || {};
//     const senderEmail = user.email || user.username || req.body.senderEmail || null;
//     const senderName = user.fullName || user.name || req.body.senderName || senderEmail;

//     const receiverEmail = result.receiverEmail || result.toEmail || req.body.toEmail || null;
//     const receiverName = result.receiverName || req.body.receiverName || receiverEmail;

//     if (!senderEmail && !receiverEmail) {
//       logger.warn("[Gateway][TX] triggerGatewayTxEmail: aucun email sender/receiver, skip.");
//       return;
//     }

//     const txId = result.transactionId || result.id || reference || null;
//     const txReference = reference || result.reference || null;
//     const amount = result.amount || req.body.amount || 0;

//     const currency = result.currency || req.body.currency || req.body.senderCurrencySymbol || req.body.localCurrencySymbol || "---";

//     const frontendBase =
//       config.frontendUrl ||
//       config.frontUrl ||
//       (Array.isArray(config.cors?.origins) && config.cors.origins[0]) ||
//       "https://www.paynoval.com";

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
//       reason: type === "cancelled" ? result.reason || req.body.reason || "" : undefined,
//       links: {
//         sender: `${frontendBase}/transactions`,
//         receiverConfirm: txId ? `${frontendBase}/transactions/confirm/${encodeURIComponent(txId)}` : "",
//       },
//     };

//     await notifyTransactionEvent(payload);
//     logger.info("[Gateway][TX] triggerGatewayTxEmail OK", { type, provider, txId, senderEmail, receiverEmail });
//   } catch (err) {
//     logger.error("[Gateway][TX] triggerGatewayTxEmail ERROR", { type, provider, message: err.message });
//   }
// }

// // ✅ Extract array de transactions depuis une réponse provider (formats variés)
// function extractTxArrayFromProviderPayload(payload) {
//   const candidates = [
//     payload?.data,
//     payload?.transactions,
//     payload?.data?.transactions,
//     payload?.data?.data,
//     payload?.result,
//     payload?.items,
//   ];
//   for (const c of candidates) {
//     if (Array.isArray(c)) return c;
//   }
//   return [];
// }

// // ✅ Ré-injecte la liste merged dans le même format que le provider
// function injectTxArrayIntoProviderPayload(payload, merged) {
//   if (!payload || typeof payload !== "object") return { success: true, data: merged };

//   if (Array.isArray(payload.data)) {
//     payload.data = merged;
//     return payload;
//   }
//   if (Array.isArray(payload.transactions)) {
//     payload.transactions = merged;
//     return payload;
//   }
//   if (payload.data && Array.isArray(payload.data.transactions)) {
//     payload.data.transactions = merged;
//     return payload;
//   }
//   if (payload.data && Array.isArray(payload.data.data)) {
//     payload.data.data = merged;
//     return payload;
//   }

//   payload.data = merged;
//   payload.success = payload.success ?? true;
//   return payload;
// }

// // ✅ Tri date homogène + dédup (reference/providerTxId/_id)
// function txSortTime(tx) {
//   const d = tx?.confirmedAt || tx?.completedAt || tx?.cancelledAt || tx?.createdAt || tx?.updatedAt || null;
//   const t = d ? new Date(d).getTime() : 0;
//   return Number.isFinite(t) ? t : 0;
// }

// function buildDedupKey(tx) {
//   const ref = tx?.reference ? String(tx.reference) : "";
//   const ptx = tx?.providerTxId ? String(tx.providerTxId) : "";
//   const id = tx?._id ? String(tx._id) : tx?.id ? String(tx.id) : "";
//   return ref || ptx || id || JSON.stringify(tx).slice(0, 120);
// }

// function mergeAndDedupTx(providerList = [], gatewayList = []) {
//   const map = new Map();

//   for (const tx of providerList) map.set(buildDedupKey(tx), tx);
//   for (const tx of gatewayList) {
//     const k = buildDedupKey(tx);
//     if (!map.has(k)) map.set(k, tx);
//   }

//   const merged = Array.from(map.values());
//   merged.sort((a, b) => txSortTime(b) - txSortTime(a));
//   return merged;
// }

// /* -------------------------------------------------------------------
//  *                       CONTROLLER ACTIONS
//  * ------------------------------------------------------------------- */

// exports.getTransaction = async (req, res) => {
//   const provider = resolveProvider(req, "paynoval");
//   const targetService = PROVIDER_TO_SERVICE[provider];

//   if (!targetService) {
//     return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
//   }

//   const { id } = req.params;
//   const base = String(targetService).replace(/\/+$/, "");
//   const url = `${base}/transactions/${encodeURIComponent(id)}`;

//   try {
//     const response = await safeAxiosRequest({
//       method: "get",
//       url,
//       headers: auditForwardHeaders(req),
//       params: req.query,
//       timeout: 10000,
//     });
//     return res.status(response.status).json(response.data);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       return res.status(503).json({
//         success: false,
//         error: "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
//         details: "cloudflare_challenge",
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === "string" ? err.response.data : null) ||
//       "Erreur lors du proxy GET transaction";

//     if (status === 429) {
//       error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.";
//     }

//     logger.error("[Gateway][TX] Erreur GET transaction:", { status, error, provider, transactionId: id });
//     return res.status(status).json({ success: false, error });
//   }
// };

// exports.listTransactions = async (req, res) => {
//   const provider = resolveProvider(req, "paynoval");
//   const targetService = PROVIDER_TO_SERVICE[provider];

//   const userId = getUserId(req);
//   if (!userId) {
//     return res.status(401).json({ success: false, error: "Non autorisé." });
//   }

//   const toNum = (v, fallback) => {
//     const n = Number(v);
//     return Number.isFinite(n) ? n : fallback;
//   };

//   const normalizeListMeta = (payloadObj, mergedList) => {
//     const out = payloadObj && typeof payloadObj === "object" ? payloadObj : { success: true };
//     const limit = toNum(req.query?.limit ?? out.limit, 25);
//     const skip = toNum(req.query?.skip ?? out.skip, 0);

//     out.success = out.success ?? true;
//     out.count = mergedList.length;
//     out.total = mergedList.length;
//     out.limit = limit;
//     out.skip = skip;
//     out.items = mergedList.length;

//     return out;
//   };

//   const gatewayQuery = {
//     provider,
//     $or: [{ userId }, { ownerUserId: userId }, { initiatorUserId: userId }, { createdBy: userId }, { receiver: userId }],
//   };

//   let gatewayTx = [];
//   try {
//     gatewayTx = await Transaction.find(gatewayQuery)
//       .select("-securityCodeHash -securityQuestion")
//       .sort({ createdAt: -1 })
//       .limit(300)
//       .lean();

//     gatewayTx = (gatewayTx || []).map((t) => ({
//       ...t,
//       id: t?._id ? String(t._id) : t?.id,
//     }));
//   } catch (e) {
//     logger.warn("[Gateway][TX] listTransactions: failed to read gateway DB", { message: e?.message });
//     gatewayTx = [];
//   }

//   if (!targetService) {
//     return res.status(200).json({
//       success: true,
//       data: gatewayTx,
//       count: gatewayTx.length,
//       total: gatewayTx.length,
//       limit: toNum(req.query?.limit, 25),
//       skip: toNum(req.query?.skip, 0),
//     });
//   }

//   const base = String(targetService).replace(/\/+$/, "");
//   const url = `${base}/transactions`;

//   try {
//     const response = await safeAxiosRequest({
//       method: "get",
//       url,
//       headers: auditForwardHeaders(req),
//       params: req.query,
//       timeout: 15000,
//     });

//     const payload = response.data || {};
//     const providerList = extractTxArrayFromProviderPayload(payload);

//     const merged = mergeAndDedupTx(providerList, gatewayTx);

//     let finalPayload = injectTxArrayIntoProviderPayload(payload, merged);
//     finalPayload = normalizeListMeta(finalPayload, merged);

//     return res.status(response.status).json(finalPayload);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       return res.status(200).json({
//         success: true,
//         data: gatewayTx,
//         count: gatewayTx.length,
//         total: gatewayTx.length,
//         limit: toNum(req.query?.limit, 25),
//         skip: toNum(req.query?.skip, 0),
//         warning: "provider_cloudflare_challenge",
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === "string" ? err.response.data : null) ||
//       "Erreur lors du proxy GET transactions";

//     if (status === 429) {
//       error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants.";
//     }

//     logger.error("[Gateway][TX] Erreur GET transactions (fallback gateway DB)", { status, error, provider });

//     return res.status(200).json({
//       success: true,
//       data: gatewayTx,
//       count: gatewayTx.length,
//       total: gatewayTx.length,
//       limit: toNum(req.query?.limit, 25),
//       skip: toNum(req.query?.skip, 0),
//       warning: "provider_unavailable",
//     });
//   }
// };

// /**
//  * POST /transactions/initiate
//  * ✅ Routing basé sur providerSelected (req.routedProvider)
//  * ✅ Stocke action/funds/destination/providerSelected dans la TX gateway
//  *
//  * NOTE sécurité:
//  * - On ne casse pas le front: securityQuestion/securityCode ne sont plus "hard required" pour deposit.
//  * - Si action = withdraw/send et fields présents => on les utilise (hash + lock)
//  */
// // exports.initiateTransaction = async (req, res) => {
// //   // ✅ ProviderSelected vient du middleware (sinon fallback compute)
// //   const actionTx = String(req.body?.action || "send").toLowerCase();
// //   const funds = req.body?.funds;
// //   const destination = req.body?.destination;

// //   const providerSelected = resolveProvider(req, computeProviderSelected(actionTx, funds, destination));
// //   const targetService = PROVIDER_TO_SERVICE[providerSelected];
// //   const base = targetService ? String(targetService).replace(/\/+$/, "") : null;
// //   const targetUrl = base ? base + "/transactions/initiate" : null;

// //   if (!targetUrl) {
// //     return res.status(400).json({ success: false, error: "Provider (providerSelected) inconnu." });
// //   }

// //   const userId = getUserId(req);
// //   if (!userId) {
// //     return res.status(401).json({ success: false, error: "Non autorisé (utilisateur manquant)." });
// //   }

// //   const now = new Date();

// //   // ✅ sécurité (soft, sans casser deposit)
// //   const securityQuestion = (req.body.securityQuestion || req.body.question || "").trim();
// //   const securityCode = (req.body.securityCode || "").trim();

// //   const shouldUseSecurity =
// //     (actionTx === "send" || actionTx === "withdraw") && !!securityQuestion && !!securityCode;

// //   const requiresSecurityValidation = !!shouldUseSecurity;
// //   const securityCodeHash = shouldUseSecurity ? hashSecurityCode(securityCode) : undefined;

// //   try {
// //     // ✅ On forward le body normalisé (middleware a déjà mis provider/action)
// //     const response = await safeAxiosRequest({
// //       method: "post",
// //       url: targetUrl,
// //       data: req.body,
// //       headers: auditForwardHeaders(req),
// //       timeout: 15000,
// //     });

// //     const result = response.data || {};

// //     const reference = result.reference || result.transaction?.reference || null;
// //     const providerTxId = result.id || result.transactionId || result.transaction?.id || null;

// //     const finalReference = reference || (providerTxId ? String(providerTxId) : null);
// //     const statusResult = result.status || "pending";

// //     await AMLLog.create({
// //       userId,
// //       type: "initiate",
// //       provider: providerSelected,
// //       amount: req.body.amount,
// //       toEmail: req.body.toEmail || "",
// //       details: cleanSensitiveMeta(req.body),
// //       flagged: req.amlFlag || false,
// //       flagReason: req.amlReason || "",
// //       createdAt: now,
// //     });

// //     await Transaction.create({
// //       userId, // legacy
// //       ownerUserId: userId,
// //       initiatorUserId: userId,

// //       provider: providerSelected,

// //       // ✅ stockage flow
// //       action: actionTx,
// //       funds: req.body.funds,
// //       destination: req.body.destination,
// //       providerSelected: providerSelected,

// //       amount: Number(req.body.amount),

// //       status: statusResult,
// //       toEmail: req.body.toEmail || undefined,
// //       toIBAN: req.body.iban || undefined,
// //       toPhone: req.body.phoneNumber || undefined,
// //       currency:
// //         req.body.currency ||
// //         req.body.senderCurrencySymbol ||
// //         req.body.localCurrencySymbol ||
// //         undefined,
// //       operator: req.body.operator || undefined,
// //       country: req.body.country || undefined,

// //       reference: finalReference,
// //       providerTxId: providerTxId ? String(providerTxId) : undefined,

// //       meta: {
// //         ...cleanSensitiveMeta(req.body),
// //         reference: finalReference || "",
// //         id: providerTxId ? String(providerTxId) : undefined,
// //         providerTxId: providerTxId ? String(providerTxId) : undefined,
// //         ownerUserId: toIdStr(userId),
// //         initiatorUserId: toIdStr(userId),

// //         // ✅ traces flow
// //         action: actionTx,
// //         funds: req.body.funds,
// //         destination: req.body.destination,
// //         providerSelected: providerSelected,
// //       },

// //       createdAt: now,
// //       updatedAt: now,

// //       requiresSecurityValidation,
// //       securityQuestion: requiresSecurityValidation ? securityQuestion : undefined,
// //       securityCodeHash: requiresSecurityValidation ? securityCodeHash : undefined,
// //       securityAttempts: 0,
// //       securityLockedUntil: null,
// //     });

// //     await triggerGatewayTxEmail("initiated", {
// //       provider: providerSelected,
// //       req,
// //       result,
// //       reference: finalReference,
// //     });

// //     if (providerSelected !== "paynoval") {
// //       try {
// //         const rawFee = (result && (result.fees || result.fee || result.transactionFees)) || null;
// //         if (rawFee) {
// //           const feeAmount = parseFloat(rawFee);
// //           if (!Number.isNaN(feeAmount) && feeAmount > 0) {
// //             const feeCurrency =
// //               result.feeCurrency ||
// //               result.currency ||
// //               req.body.currency ||
// //               req.body.senderCurrencySymbol ||
// //               req.body.localCurrencySymbol ||
// //               "CAD";

// //             await creditAdminCommissionFromGateway({
// //               provider: providerSelected,
// //               kind: "transaction",
// //               amount: feeAmount,
// //               currency: feeCurrency,
// //               req,
// //             });
// //           }
// //         }
// //       } catch (e) {
// //         logger.error("[Gateway][Fees] Erreur crédit admin (initiate)", {
// //           provider: providerSelected,
// //           message: e.message,
// //         });
// //       }
// //     }

// //     return res.status(response.status).json(result);
// //   } catch (err) {
// //     if (err.isCloudflareChallenge) {
// //       return res.status(503).json({
// //         success: false,
// //         error: "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
// //         details: "cloudflare_challenge",
// //       });
// //     }

// //     const status = err.response?.status || 502;
// //     let error =
// //       err.response?.data?.error ||
// //       err.response?.data?.message ||
// //       (typeof err.response?.data === "string" ? err.response.data : null) ||
// //       err.message ||
// //       "Erreur interne provider";

// //     if (status === 429) {
// //       error = "Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.";
// //     }

// //     try {
// //       await AMLLog.create({
// //         userId,
// //         type: "initiate",
// //         provider: providerSelected,
// //         amount: req.body.amount,
// //         toEmail: req.body.toEmail || "",
// //         details: cleanSensitiveMeta({ ...req.body, error }),
// //         flagged: req.amlFlag || false,
// //         flagReason: req.amlReason || "",
// //         createdAt: now,
// //       });

// //       await Transaction.create({
// //         userId,
// //         ownerUserId: userId,
// //         initiatorUserId: userId,

// //         provider: providerSelected,

// //         // flow traces
// //         action: actionTx,
// //         funds: req.body.funds,
// //         destination: req.body.destination,
// //         providerSelected: providerSelected,

// //         amount: req.body.amount,
// //         status: "failed",
// //         toEmail: req.body.toEmail || undefined,
// //         toIBAN: req.body.iban || undefined,
// //         toPhone: req.body.phoneNumber || undefined,
// //         currency:
// //           req.body.currency ||
// //           req.body.senderCurrencySymbol ||
// //           req.body.localCurrencySymbol ||
// //           undefined,
// //         operator: req.body.operator || undefined,
// //         country: req.body.country || undefined,
// //         reference: null,
// //         meta: {
// //           ...cleanSensitiveMeta({ ...req.body, error }),
// //           ownerUserId: toIdStr(userId),
// //           initiatorUserId: toIdStr(userId),
// //           action: actionTx,
// //           funds: req.body.funds,
// //           destination: req.body.destination,
// //           providerSelected: providerSelected,
// //         },
// //         createdAt: now,
// //         updatedAt: now,
// //       });
// //     } catch {}

// //     logger.error("[Gateway][TX] initiateTransaction failed", { provider: providerSelected, error, status });
// //     return res.status(status).json({ success: false, error });
// //   }
// // };


// /**
//  * POST /transactions/initiate
//  * ✅ Routing basé sur providerSelected (req.routedProvider)
//  * ✅ Stocke action/funds/destination/providerSelected dans la TX gateway
//  *
//  * OTP (PayNoval): dépôt MobileMoney -> PayNoval sur numéro différent
//  * => autorisé uniquement si numéro "trusted" (OTP validé)
//  */

// /**
//  * POST /transactions/initiate
//  */
// exports.initiateTransaction = async (req, res) => {
//   const actionTx = String(req.body?.action || "send").toLowerCase();
//   const funds = req.body?.funds;
//   const destination = req.body?.destination;

//   const providerSelected = resolveProvider(
//     req,
//     computeProviderSelected(actionTx, funds, destination)
//   );

//   const targetService = PROVIDER_TO_SERVICE[providerSelected];
//   const base = targetService ? String(targetService).replace(/\/+$/, "") : null;
//   const targetUrl = base ? base + "/transactions/initiate" : null;

//   if (!targetUrl) {
//     return res
//       .status(400)
//       .json({ success: false, error: "Provider (providerSelected) inconnu." });
//   }

//   const userId = getUserId(req);
//   if (!userId) {
//     return res
//       .status(401)
//       .json({ success: false, error: "Non autorisé (utilisateur manquant)." });
//   }

//   // ✅ Guard OTP : dépôt MobileMoney -> PayNoval sur un numéro différent
//   try {
//     const actionNorm = String(req.body?.action || "send").toLowerCase();
//     const fundsNorm = String(req.body?.funds || "").toLowerCase();
//     const destNorm = String(req.body?.destination || "").toLowerCase();

//     if (
//       actionNorm === "deposit" &&
//       fundsNorm === "mobilemoney" &&
//       destNorm === "paynoval"
//     ) {
//       const rawPhone =
//         req.body?.phoneNumber || req.body?.toPhone || req.body?.phone || "";
//       const country =
//         req.body?.country || req.user?.country || req.user?.selectedCountry || "";

//       const phoneE164 = normalizePhoneE164(rawPhone, country);

//       if (!phoneE164) {
//         return res.status(400).json({
//           success: false,
//           error:
//             "Numéro de dépôt invalide. Format attendu: E.164 (ex: +2250700000000) ou numéro local valide selon le pays.",
//           code: "PHONE_INVALID",
//         });
//       }

//       // Même numéro que le user => OK sans trusted
//       const userPhoneE164 = pickUserPrimaryPhoneE164(req.user, country);
//       const isSameAsUser =
//         userPhoneE164 && String(userPhoneE164) === String(phoneE164);

//       if (!isSameAsUser) {
//         // 1) DB trusted
//         const trustedDoc = await TrustedDepositNumber.findOne({
//           userId,
//           phoneE164,
//           status: "trusted",
//         }).lean();

//         if (!trustedDoc) {
//           // 2) ✅ status API (ta demande)
//           const st = await fetchOtpStatus({ req, phoneE164, country });

//           // si status dit trusted => on laisse passer (optionnel: upsert)
//           if (st?.trusted) {
//             try {
//               await TrustedDepositNumber.updateOne(
//                 { userId, phoneE164 },
//                 {
//                   $set: {
//                     userId,
//                     phoneE164,
//                     status: "trusted",
//                     verifiedAt: new Date(),
//                     updatedAt: new Date(),
//                   },
//                   $setOnInsert: { createdAt: new Date() },
//                 },
//                 { upsert: true }
//               );
//             } catch {}
//           } else {
//             // ✅ pending => NE PAS relancer start
//             if (String(st?.status || "").toLowerCase() === "pending") {
//               return res.status(403).json({
//                 success: false,
//                 error:
//                   "Vérification SMS déjà en cours pour ce numéro. Entre le code reçu (ne relance pas l’OTP).",
//                 code: "PHONE_VERIFICATION_PENDING",
//                 otpStatus: { status: "pending", skipStart: true },
//                 nextStep: {
//                   status: "/api/v1/phone-verification/status",
//                   start: "/api/v1/phone-verification/start",
//                   verify: "/api/v1/phone-verification/verify",
//                   phoneNumber: phoneE164,
//                   country,
//                   skipStart: true,
//                 },
//               });
//             }

//             // none/unknown => il faut start
//             return res.status(403).json({
//               success: false,
//               error:
//                 "Ce numéro n’est pas vérifié. Vérifie d’abord le numéro par SMS avant de déposer.",
//               code: "PHONE_NOT_TRUSTED",
//               otpStatus: { status: st?.status || "none", skipStart: false },
//               nextStep: {
//                 status: "/api/v1/phone-verification/status",
//                 start: "/api/v1/phone-verification/start",
//                 verify: "/api/v1/phone-verification/verify",
//                 phoneNumber: phoneE164,
//                 country,
//                 skipStart: false,
//               },
//             });
//           }
//         }
//       }

//       // ✅ réécriture E.164 vers provider
//       req.body.phoneNumber = phoneE164;
//     }
//   } catch (e) {
//     logger?.warn?.("[Gateway][OTP] trusted check failed", { message: e?.message });
//     return res.status(500).json({
//       success: false,
//       error: "Erreur vérification numéro.",
//     });
//   }

//   const now = new Date();

//   // ✅ sécurité
//   const securityQuestion = (req.body.securityQuestion || req.body.question || "").trim();
//   const securityCode = (req.body.securityCode || "").trim();

//   const shouldUseSecurity =
//     (actionTx === "send" || actionTx === "withdraw") &&
//     !!securityQuestion &&
//     !!securityCode;

//   const requiresSecurityValidation = !!shouldUseSecurity;
//   const securityCodeHash = shouldUseSecurity ? hashSecurityCode(securityCode) : undefined;

//   try {
//     const response = await safeAxiosRequest({
//       method: "post",
//       url: targetUrl,
//       data: req.body,
//       headers: auditForwardHeaders(req),
//       timeout: 15000,
//     });

//     const result = response.data || {};

//     const reference = result.reference || result.transaction?.reference || null;
//     const providerTxId =
//       result.id || result.transactionId || result.transaction?.id || null;

//     const finalReference = reference || (providerTxId ? String(providerTxId) : null);
//     const statusResult = result.status || "pending";

//     await AMLLog.create({
//       userId,
//       type: "initiate",
//       provider: providerSelected,
//       amount: req.body.amount,
//       toEmail: req.body.toEmail || "",
//       details: cleanSensitiveMeta(req.body),
//       flagged: req.amlFlag || false,
//       flagReason: req.amlReason || "",
//       createdAt: now,
//     });

//     await Transaction.create({
//       userId,
//       ownerUserId: userId,
//       initiatorUserId: userId,
//       provider: providerSelected,

//       action: actionTx,
//       funds: req.body.funds,
//       destination: req.body.destination,
//       providerSelected,

//       amount: Number(req.body.amount),
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

//       reference: finalReference,
//       providerTxId: providerTxId ? String(providerTxId) : undefined,

//       meta: {
//         ...cleanSensitiveMeta(req.body),
//         reference: finalReference || "",
//         id: providerTxId ? String(providerTxId) : undefined,
//         providerTxId: providerTxId ? String(providerTxId) : undefined,
//         ownerUserId: toIdStr(userId),
//         initiatorUserId: toIdStr(userId),
//         action: actionTx,
//         funds: req.body.funds,
//         destination: req.body.destination,
//         providerSelected,
//       },

//       createdAt: now,
//       updatedAt: now,

//       requiresSecurityValidation,
//       securityQuestion: requiresSecurityValidation ? securityQuestion : undefined,
//       securityCodeHash: requiresSecurityValidation ? securityCodeHash : undefined,
//       securityAttempts: 0,
//       securityLockedUntil: null,
//     });

//     await triggerGatewayTxEmail("initiated", {
//       provider: providerSelected,
//       req,
//       result,
//       reference: finalReference,
//     });

//     if (providerSelected !== "paynoval") {
//       try {
//         const rawFee =
//           (result && (result.fees || result.fee || result.transactionFees)) || null;
//         if (rawFee) {
//           const feeAmount = parseFloat(rawFee);
//           if (!Number.isNaN(feeAmount) && feeAmount > 0) {
//             const feeCurrency =
//               result.feeCurrency ||
//               result.currency ||
//               req.body.currency ||
//               req.body.senderCurrencySymbol ||
//               req.body.localCurrencySymbol ||
//               "CAD";

//             await creditAdminCommissionFromGateway({
//               provider: providerSelected,
//               kind: "transaction",
//               amount: feeAmount,
//               currency: feeCurrency,
//               req,
//             });
//           }
//         }
//       } catch (e) {
//         logger?.error?.("[Gateway][Fees] Erreur crédit admin (initiate)", {
//           provider: providerSelected,
//           message: e.message,
//         });
//       }
//     }

//     return res.status(response.status).json(result);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       return res.status(503).json({
//         success: false,
//         error:
//           "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
//         details: "cloudflare_challenge",
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === "string" ? err.response.data : null) ||
//       err.message ||
//       "Erreur interne provider";

//     if (status === 429) {
//       error =
//         "Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.";
//     }

//     try {
//       await AMLLog.create({
//         userId,
//         type: "initiate",
//         provider: providerSelected,
//         amount: req.body.amount,
//         toEmail: req.body.toEmail || "",
//         details: cleanSensitiveMeta({ ...req.body, error }),
//         flagged: req.amlFlag || false,
//         flagReason: req.amlReason || "",
//         createdAt: now,
//       });

//       await Transaction.create({
//         userId,
//         ownerUserId: userId,
//         initiatorUserId: userId,
//         provider: providerSelected,

//         action: actionTx,
//         funds: req.body.funds,
//         destination: req.body.destination,
//         providerSelected,

//         amount: req.body.amount,
//         status: "failed",

//         toEmail: req.body.toEmail || undefined,
//         toIBAN: req.body.iban || undefined,
//         toPhone: req.body.phoneNumber || undefined,

//         currency:
//           req.body.currency ||
//           req.body.senderCurrencySymbol ||
//           req.body.localCurrencySymbol ||
//           undefined,

//         operator: req.body.operator || undefined,
//         country: req.body.country || undefined,

//         reference: null,
//         meta: {
//           ...cleanSensitiveMeta({ ...req.body, error }),
//           ownerUserId: toIdStr(userId),
//           initiatorUserId: toIdStr(userId),
//           action: actionTx,
//           funds: req.body.funds,
//           destination: req.body.destination,
//           providerSelected,
//         },
//         createdAt: now,
//         updatedAt: now,
//       });
//     } catch {}

//     logger?.error?.("[Gateway][TX] initiateTransaction failed", {
//       provider: providerSelected,
//       error,
//       status,
//     });

//     return res.status(status).json({ success: false, error });
//   }
// };











// /**
//  * POST /transactions/confirm
//  * (inchangé sur le fond)
//  */
// exports.confirmTransaction = async (req, res) => {
//   const provider = resolveProvider(req, "paynoval");
//   const { transactionId, securityCode } = req.body || {};

//   const targetService = PROVIDER_TO_SERVICE[provider];
//   const base = targetService ? String(targetService).replace(/\/+$/, "") : null;
//   const targetUrl = base ? base + "/transactions/confirm" : null;

//   if (!targetUrl) {
//     return res.status(400).json({ success: false, error: "Provider (destination) inconnu." });
//   }

//   const confirmCallerUserId = getUserId(req);
//   const now = new Date();

//   let txRecord = await findGatewayTxForConfirm(provider, transactionId, req.body);

//   if (!txRecord && base && transactionId) {
//     const ids = await fetchProviderTxIdentifiers({ base, req, providerTxId: transactionId });
//     if (ids?.reference || ids?.providerTxId) {
//       txRecord = await findGatewayTxForConfirm(provider, ids.providerTxId || transactionId, {
//         ...req.body,
//         reference: ids.reference || undefined,
//         providerTxId: ids.providerTxId || undefined,
//       });
//     }
//   }

//   const normalizeStatus = (raw) => {
//     const s = String(raw || "").toLowerCase().trim();
//     if (s === "cancelled" || s === "canceled") return "canceled";
//     if (s === "confirmed" || s === "success" || s === "validated" || s === "completed") return "confirmed";
//     if (s === "failed" || s === "error" || s === "declined" || s === "rejected") return "failed";
//     if (s === "pending" || s === "processing" || s === "in_progress") return "pending";
//     return s || "confirmed";
//   };

//   if (provider !== "paynoval") {
//     if (!txRecord) {
//       return res.status(404).json({ success: false, error: "Transaction non trouvée dans le Gateway." });
//     }

//     if (txRecord.status !== "pending") {
//       return res.status(400).json({ success: false, error: "Transaction déjà traitée ou annulée." });
//     }

//     if (txRecord.requiresSecurityValidation && txRecord.securityCodeHash) {
//       if (txRecord.securityLockedUntil && txRecord.securityLockedUntil > now) {
//         return res.status(423).json({
//           success: false,
//           error: "Transaction temporairement bloquée suite à des tentatives infructueuses. Réessayez plus tard.",
//         });
//       }

//       if (!securityCode) {
//         return res.status(400).json({
//           success: false,
//           error: "securityCode requis pour confirmer cette transaction.",
//         });
//       }

//       if (!verifySecurityCode(securityCode, txRecord.securityCodeHash)) {
//         const attempts = (txRecord.securityAttempts || 0) + 1;
//         const update = { securityAttempts: attempts, updatedAt: now };
//         let errorMsg;

//         if (attempts >= 3) {
//           update.status = "canceled";
//           update.cancelledAt = now;
//           update.cancelReason = "Code de sécurité erroné (trop d’essais)";
//           update.securityLockedUntil = new Date(now.getTime() + 15 * 60 * 1000);

//           errorMsg = "Code de sécurité incorrect. Nombre d’essais dépassé, transaction annulée.";

//           await triggerGatewayTxEmail("cancelled", {
//             provider,
//             req,
//             result: {
//               ...(txRecord.toObject ? txRecord.toObject() : txRecord),
//               status: "canceled",
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
//         { $set: { securityAttempts: 0, securityLockedUntil: null, updatedAt: now } }
//       );
//     }
//   }

//   try {
//     const response = await safeAxiosRequest({
//       method: "post",
//       url: targetUrl,
//       data: req.body,
//       headers: auditForwardHeaders(req),
//       timeout: 15000,
//     });

//     const result = response.data || {};
//     const newStatus = normalizeStatus(result.status || "confirmed");

//     const refFromResult = result.reference || result.transaction?.reference || req.body.reference || null;
//     const idFromResult = result.id || result.transaction?.id || result.transactionId || transactionId || null;

//     const candidates = Array.from(
//       new Set(
//         [
//           refFromResult,
//           idFromResult,
//           transactionId,
//           txRecord?.reference,
//           txRecord?.providerTxId,
//           txRecord?.meta?.reference,
//           txRecord?.meta?.id,
//           txRecord?.meta?.providerTxId,
//         ]
//           .filter(Boolean)
//           .map(String)
//       )
//     );

//     await AMLLog.create({
//       userId: confirmCallerUserId,
//       type: "confirm",
//       provider,
//       amount: result.amount || 0,
//       toEmail: result.recipientEmail || result.toEmail || result.email || "",
//       details: cleanSensitiveMeta(req.body),
//       flagged: false,
//       flagReason: "",
//       createdAt: now,
//     });

//     const query = {
//       provider,
//       $or: [
//         ...candidates.map((v) => ({ reference: v })),
//         ...candidates.map((v) => ({ providerTxId: v })),
//         ...candidates.map((v) => ({ "meta.reference": v })),
//         ...candidates.map((v) => ({ "meta.id": v })),
//         ...candidates.map((v) => ({ "meta.providerTxId": v })),
//       ],
//     };

//     const resilientOwnerUserId =
//       txRecord?.ownerUserId || txRecord?.initiatorUserId || txRecord?.meta?.ownerUserId || txRecord?.userId || null;

//     const patch = {
//       status: newStatus,
//       confirmedAt: newStatus === "confirmed" ? now : undefined,
//       cancelledAt: newStatus === "canceled" ? now : undefined,
//       updatedAt: now,

//       providerTxId: idFromResult ? String(idFromResult) : undefined,
//       ...(refFromResult ? { reference: String(refFromResult) } : {}),

//       ...(resilientOwnerUserId ? { ownerUserId: resilientOwnerUserId } : {}),
//       ...(resilientOwnerUserId ? { initiatorUserId: txRecord?.initiatorUserId || resilientOwnerUserId } : {}),

//       meta: {
//         ...(txRecord?.meta || {}),
//         ...(idFromResult ? { id: String(idFromResult), providerTxId: String(idFromResult) } : {}),
//         ...(refFromResult ? { reference: String(refFromResult) } : {}),
//         ...(resilientOwnerUserId ? { ownerUserId: toIdStr(resilientOwnerUserId) } : {}),
//         ...(resilientOwnerUserId
//           ? { initiatorUserId: toIdStr(txRecord?.initiatorUserId || resilientOwnerUserId) }
//           : {}),
//       },
//     };

//     let gatewayTx = null;
//     if (txRecord?._id) {
//       gatewayTx = await Transaction.findByIdAndUpdate(txRecord._id, { $set: patch }, { new: true });
//     } else {
//       gatewayTx = await Transaction.findOneAndUpdate(query, { $set: patch }, { new: true });
//     }

//     if (!gatewayTx && base && idFromResult) {
//       const ids = await fetchProviderTxIdentifiers({ base, req, providerTxId: idFromResult });
//       if (ids?.reference) {
//         gatewayTx = await Transaction.findOneAndUpdate(
//           {
//             provider,
//             $or: [
//               { reference: String(ids.reference) },
//               { "meta.reference": String(ids.reference) },
//               { providerTxId: String(idFromResult) },
//               { "meta.id": String(idFromResult) },
//               { "meta.providerTxId": String(idFromResult) },
//             ],
//           },
//           {
//             $set: {
//               ...patch,
//               reference: String(ids.reference),
//               meta: { ...(patch.meta || {}), reference: String(ids.reference) },
//             },
//           },
//           { new: true }
//         );
//       }
//     }

//     if (newStatus === "confirmed") {
//       await triggerGatewayTxEmail("confirmed", { provider, req, result, reference: refFromResult || transactionId });
//     } else if (newStatus === "canceled") {
//       await triggerGatewayTxEmail("cancelled", { provider, req, result, reference: refFromResult || transactionId });
//     } else if (newStatus === "failed") {
//       await triggerGatewayTxEmail("failed", { provider, req, result, reference: refFromResult || transactionId });
//     }

//     if (newStatus === "confirmed") {
//       const referralUserId = resolveReferralOwnerUserId(gatewayTx || txRecord, confirmCallerUserId);

//       if (!referralUserId) {
//         logger.warn("[Gateway][TX][Referral] owner introuvable/ambigu => SKIP (évite attribution au destinataire)", {
//           provider,
//           transactionId,
//           gatewayTxId: gatewayTx?._id,
//           confirmCallerUserId: confirmCallerUserId ? toIdStr(confirmCallerUserId) : null,
//         });
//       } else {
//         try {
//           const txForReferral = {
//             id: String(idFromResult || refFromResult || transactionId || ""),
//             reference: refFromResult ? String(refFromResult) : gatewayTx?.reference ? String(gatewayTx.reference) : "",
//             status: "confirmed",
//             amount: Number(result.amount || gatewayTx?.amount || txRecord?.amount || 0),
//             currency: String(result.currency || gatewayTx?.currency || txRecord?.currency || req.body.currency || "CAD"),
//             country: String(result.country || gatewayTx?.country || txRecord?.country || req.body.country || ""),
//             provider: String(provider),
//             createdAt: (gatewayTx?.createdAt || txRecord?.createdAt)
//               ? new Date(gatewayTx?.createdAt || txRecord?.createdAt).toISOString()
//               : new Date().toISOString(),
//             confirmedAt: new Date().toISOString(),
//             ownerUserId: toIdStr(referralUserId),
//             confirmCallerUserId: confirmCallerUserId ? toIdStr(confirmCallerUserId) : null,
//           };

//           await checkAndGenerateReferralCodeInMain(referralUserId, null, txForReferral);
//           await processReferralBonusIfEligible(referralUserId, null);
//         } catch (e) {
//           logger.warn("[Gateway][TX][Referral] referral utils failed", {
//             referralUserId: toIdStr(referralUserId),
//             message: e?.message,
//           });
//         }

//         try {
//           await notifyReferralOnConfirm({
//             userId: referralUserId,
//             provider,
//             transaction: {
//               id: String(idFromResult || refFromResult || transactionId || ""),
//               reference: refFromResult ? String(refFromResult) : gatewayTx?.reference ? String(gatewayTx.reference) : "",
//               amount: Number(result.amount || gatewayTx?.amount || txRecord?.amount || 0),
//               currency: String(result.currency || gatewayTx?.currency || txRecord?.currency || req.body.currency || "CAD"),
//               country: String(result.country || gatewayTx?.country || txRecord?.country || req.body.country || ""),
//               provider: String(provider),
//               confirmedAt: new Date().toISOString(),
//             },
//             requestId: req.id,
//           });
//         } catch (e) {
//           logger.warn("[Gateway][Referral] notifyReferralOnConfirm failed", { message: e?.message });
//         }
//       }
//     }

//     return res.status(response.status).json(result);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       return res.status(503).json({
//         success: false,
//         error: "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
//         details: "cloudflare_challenge",
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === "string" ? err.response.data : null) ||
//       err.message ||
//       "Erreur interne provider";

//     if (status === 429) {
//       error = "Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.";
//     }

//     await AMLLog.create({
//       userId: confirmCallerUserId,
//       type: "confirm",
//       provider,
//       amount: 0,
//       toEmail: "",
//       details: cleanSensitiveMeta({ ...req.body, error }),
//       flagged: false,
//       flagReason: "",
//       createdAt: now,
//     });

//     await Transaction.findOneAndUpdate(
//       {
//         provider,
//         $or: [
//           { reference: String(transactionId) },
//           { providerTxId: String(transactionId) },
//           { "meta.reference": String(transactionId) },
//           { "meta.id": String(transactionId) },
//           { "meta.providerTxId": String(transactionId) },
//         ],
//       },
//       { $set: { status: "failed", updatedAt: now } }
//     );

//     logger.error("[Gateway][TX] confirmTransaction failed", { provider, error, status });
//     return res.status(status).json({ success: false, error });
//   }
// };

// /**
//  * POST /transactions/cancel
//  */
// exports.cancelTransaction = async (req, res) => {
//   const provider = resolveProvider(req, "paynoval");
//   const { transactionId } = req.body || {};

//   const targetService = PROVIDER_TO_SERVICE[provider];
//   const base = targetService ? String(targetService).replace(/\/+$/, "") : null;
//   const targetUrl = base ? base + "/transactions/cancel" : null;

//   if (!targetUrl) {
//     return res.status(400).json({ success: false, error: "Provider (destination) inconnu." });
//   }

//   const userId = getUserId(req);
//   const now = new Date();

//   try {
//     const response = await safeAxiosRequest({
//       method: "post",
//       url: targetUrl,
//       data: req.body,
//       headers: auditForwardHeaders(req),
//       timeout: 15000,
//     });

//     const result = response.data || {};
//     const newStatus = result.status || "canceled";

//     await AMLLog.create({
//       userId,
//       type: "cancel",
//       provider,
//       amount: result.amount || 0,
//       toEmail: result.toEmail || "",
//       details: cleanSensitiveMeta(req.body),
//       flagged: false,
//       flagReason: "",
//       createdAt: now,
//     });

//     await Transaction.findOneAndUpdate(
//       {
//         provider,
//         $or: [
//           { reference: String(transactionId) },
//           { providerTxId: String(transactionId) },
//           { "meta.reference": String(transactionId) },
//           { "meta.id": String(transactionId) },
//           { "meta.providerTxId": String(transactionId) },
//         ],
//       },
//       {
//         $set: {
//           status: newStatus,
//           cancelledAt: now,
//           cancelReason: req.body.reason || result.reason || "",
//           updatedAt: now,
//         },
//       }
//     );

//     await triggerGatewayTxEmail("cancelled", { provider, req, result, reference: transactionId });

//     if (provider !== "paynoval") {
//       try {
//         const rawCancellationFee =
//           result.cancellationFeeInSenderCurrency || result.cancellationFee || result.fees || null;

//         if (rawCancellationFee) {
//           const feeAmount = parseFloat(rawCancellationFee);
//           if (!Number.isNaN(feeAmount) && feeAmount > 0) {
//             const feeCurrency = result.adminCurrency || result.currency || req.body.currency || req.body.senderCurrencySymbol || "CAD";

//             await creditAdminCommissionFromGateway({
//               provider,
//               kind: "cancellation",
//               amount: feeAmount,
//               currency: feeCurrency,
//               req,
//             });
//           }
//         }
//       } catch (e) {
//         logger.error("[Gateway][Fees] Erreur crédit admin (cancel)", { provider, message: e.message });
//       }
//     }

//     return res.status(response.status).json(result);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       return res.status(503).json({
//         success: false,
//         error: "Service de paiement temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
//         details: "cloudflare_challenge",
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === "string" ? err.response.data : null) ||
//       err.message ||
//       "Erreur interne provider";

//     if (status === 429) {
//       error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.";
//     }

//     await AMLLog.create({
//       userId,
//       type: "cancel",
//       provider,
//       amount: 0,
//       toEmail: "",
//       details: cleanSensitiveMeta({ ...req.body, error }),
//       flagged: false,
//       flagReason: "",
//       createdAt: now,
//     });

//     await Transaction.findOneAndUpdate(
//       {
//         provider,
//         $or: [
//           { reference: String(transactionId) },
//           { providerTxId: String(transactionId) },
//           { "meta.reference": String(transactionId) },
//           { "meta.id": String(transactionId) },
//           { "meta.providerTxId": String(transactionId) },
//         ],
//       },
//       { $set: { status: "failed", updatedAt: now } }
//     );

//     logger.error("[Gateway][TX] cancelTransaction failed", { provider, error, status });
//     return res.status(status).json({ success: false, error });
//   }
// };

// /**
//  * ✅ Route interne log
//  */
// exports.logInternalTransaction = async (req, res) => {
//   try {
//     const now = new Date();

//     const authUserId = getUserId(req);
//     const bodyUserId = req.body?.userId;

//     const finalUserId = asObjectIdOrNull(authUserId) || asObjectIdOrNull(bodyUserId);
//     if (!finalUserId) {
//       return res.status(400).json({
//         success: false,
//         error: "userId manquant ou invalide (ObjectId requis) pour loguer la transaction.",
//       });
//     }

//     const {
//       provider = "paynoval",
//       amount,
//       status = "confirmed",
//       currency,
//       operator = "paynoval",
//       country,
//       reference,
//       meta = {},
//       createdBy,
//       receiver,
//       fees,
//       netAmount,
//       ownerUserId,
//       initiatorUserId,
//       providerTxId,
//     } = req.body || {};

//     const numAmount = Number(amount);
//     if (!numAmount || Number.isNaN(numAmount) || numAmount <= 0) {
//       return res.status(400).json({
//         success: false,
//         error: "amount invalide ou manquant pour loguer la transaction.",
//       });
//     }

//     const createdById = asObjectIdOrNull(createdBy) || finalUserId;
//     const receiverId = asObjectIdOrNull(receiver) || null;

//     const ownerId = asObjectIdOrNull(ownerUserId) || asObjectIdOrNull(initiatorUserId) || createdById;
//     const initiatorId = asObjectIdOrNull(initiatorUserId) || asObjectIdOrNull(ownerUserId) || createdById;

//     const receiverRaw = receiver && !receiverId ? receiver : undefined;
//     const createdByRaw = createdBy && !asObjectIdOrNull(createdBy) ? createdBy : undefined;

//     const tx = await Transaction.create({
//       userId: finalUserId,
//       ownerUserId: ownerId,
//       initiatorUserId: initiatorId,

//       provider,
//       amount: numAmount,
//       status,
//       currency,
//       operator,
//       country,
//       reference,
//       providerTxId: providerTxId ? String(providerTxId) : undefined,

//       requiresSecurityValidation: false,
//       securityAttempts: 0,
//       securityLockedUntil: null,

//       confirmedAt: status === "confirmed" ? now : undefined,

//       meta: {
//         ...cleanSensitiveMeta(meta),
//         ownerUserId: toIdStr(ownerId),
//         initiatorUserId: toIdStr(initiatorId),
//         ...(receiverRaw ? { receiverRaw } : {}),
//         ...(createdByRaw ? { createdByRaw } : {}),
//       },

//       createdAt: now,
//       updatedAt: now,

//       createdBy: createdById,
//       receiver: receiverId || undefined,

//       fees: typeof fees === "number" ? fees : fees != null ? Number(fees) : undefined,
//       netAmount: typeof netAmount === "number" ? netAmount : netAmount != null ? Number(netAmount) : undefined,
//     });

//     return res.status(201).json({ success: true, data: tx });
//   } catch (err) {
//     logger.error("[Gateway][TX] logInternalTransaction error", { message: err.message, stack: err.stack });
//     return res.status(500).json({
//       success: false,
//       error: "Erreur lors de la création de la transaction interne.",
//     });
//   }
// };

// exports.refundTransaction = async (req, res) => forwardTransactionProxy(req, res, "refund");
// exports.reassignTransaction = async (req, res) => forwardTransactionProxy(req, res, "reassign");
// exports.validateTransaction = async (req, res) => forwardTransactionProxy(req, res, "validate");
// exports.archiveTransaction = async (req, res) => forwardTransactionProxy(req, res, "archive");
// exports.relaunchTransaction = async (req, res) => forwardTransactionProxy(req, res, "relaunch");

// async function forwardTransactionProxy(req, res, action) {
//   const provider = resolveProvider(req, "paynoval");
//   const targetService = PROVIDER_TO_SERVICE[provider];

//   if (!targetService) {
//     return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
//   }

//   const url = String(targetService).replace(/\/+$/, "") + `/transactions/${action}`;

//   try {
//     const response = await safeAxiosRequest({
//       method: "post",
//       url,
//       data: req.body,
//       headers: auditForwardHeaders(req),
//       timeout: 15000,
//     });

//     return res.status(response.status).json(response.data);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       return res.status(503).json({
//         success: false,
//         error: "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
//         details: "cloudflare_challenge",
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === "string" ? err.response.data : null) ||
//       err.message ||
//       `Erreur proxy ${action}`;

//     if (status === 429) {
//       error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.";
//     }

//     logger.error(`[Gateway][TX] Erreur ${action}:`, { status, error, provider });
//     return res.status(status).json({ success: false, error });
//   }
// }







"use strict";

/**
 * -------------------------------------------------------------------
 * CONTROLLER TRANSACTIONS (API GATEWAY)
 * -------------------------------------------------------------------
 * PATCH FLOW UNIFIÉ (2026-01) :
 * ✅ providerSelected routing (deposit=funds, withdraw/send=destination)
 * ✅ validateTransaction middleware peut set req.providerSelected / req.routedProvider
 *
 * PATCH 2026-01-17 (Render/CF 429 fix) :
 * ✅ Circuit-breaker (cooldown) sur provider PayNoval quand Cloudflare/429
 * ✅ Fallback DB gateway + warning + retryAfterSec
 * ✅ Requires robustes (../src/... ou ../...)
 */

const axios = require("axios");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { LRUCache } = require("lru-cache");

/* ------------------------ Safe require (paths robustes) ------------------------ */
function reqAny(paths) {
  for (const p of paths) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      return require(p);
    } catch {}
  }
  const e = new Error(`Module introuvable (paths tried): ${paths.join(", ")}`);
  e.status = 500;
  throw e;
}

const config = reqAny(["../src/config", "../config"]);
const logger = reqAny(["../src/logger", "../logger"]);

const Transaction = reqAny(["../src/models/Transaction", "../models/Transaction"]);
const AMLLog = reqAny(["../src/models/AMLLog", "../models/AMLLog"]);
const TrustedDepositNumber = reqAny(["../src/models/TrustedDepositNumber", "../models/TrustedDepositNumber"]);

const { notifyTransactionEvent } = reqAny([
  "../src/services/transactionNotificationService",
  "../services/transactionNotificationService",
]);

const { checkAndGenerateReferralCodeInMain, processReferralBonusIfEligible } = reqAny([
  "../src/utils/referralUtils",
  "../utils/referralUtils",
]);

const { notifyReferralOnConfirm } = reqAny([
  "../src/services/referralGatewayService",
  "../services/referralGatewayService",
]);

/* -------------------------------------------------------------------
 *                  ✅ Cloudflare / 429 Circuit Breaker
 * ------------------------------------------------------------------- */
const FAIL_COOLDOWN_MS = Number(process.env.PROVIDER_FAIL_COOLDOWN_MS || 5 * 60 * 1000); // 5min
const FAIL_CACHE_MAX = Number(process.env.PROVIDER_FAIL_CACHE_MAX || 200);
const providerFail = new LRUCache({ max: FAIL_CACHE_MAX, ttl: FAIL_COOLDOWN_MS });

function getServiceKeyFromUrl(url) {
  try {
    const u = new URL(url);
    return u.origin; // cooldown par origin
  } catch {
    return String(url || "").slice(0, 60);
  }
}

function setProviderCooldown(url, reason, extra = {}) {
  const key = getServiceKeyFromUrl(url);
  const now = Date.now();

  // Si Retry-After présent, on le respecte
  const retryAfterSec = Number(extra.retryAfterSec);
  const cdMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : FAIL_COOLDOWN_MS;

  const payload = {
    key,
    reason: reason || "provider_unavailable",
    nextTryAt: now + cdMs,
    retryAfterSec: Math.ceil(cdMs / 1000),
    ...extra,
  };

  providerFail.set(key, payload);
  return payload;
}

function getProviderCooldown(url) {
  const key = getServiceKeyFromUrl(url);
  const v = providerFail.get(key);
  if (!v) return null;
  if (Date.now() < v.nextTryAt) return v;
  providerFail.delete(key);
  return null;
}

/* -------------------------------------------------------------------
 *                        Helpers phone OTP
 * ------------------------------------------------------------------- */

// ✅ Dial codes + tailles locales (fallback simple)
const COUNTRY_DIAL = {
  CI: { dial: "+225", localMin: 8, localMax: 10 },
  BF: { dial: "+226", localMin: 8, localMax: 8 },
  ML: { dial: "+223", localMin: 8, localMax: 8 },
  CM: { dial: "+237", localMin: 8, localMax: 9 },
  SN: { dial: "+221", localMin: 9, localMax: 9 },
  BJ: { dial: "+229", localMin: 8, localMax: 8 },
  TG: { dial: "+228", localMin: 8, localMax: 8 },
};

function digitsOnly(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

function normalizePhoneE164(rawPhone, country) {
  const raw = String(rawPhone || "").trim().replace(/\s+/g, "");
  if (!raw) return "";

  if (raw.startsWith("+")) {
    const d = "+" + digitsOnly(raw);
    if (d.length < 8 || d.length > 16) return "";
    return d;
  }

  const c = String(country || "").toUpperCase().trim();
  const cfg = COUNTRY_DIAL[c];
  if (!cfg) return "";

  const d = digitsOnly(raw);
  if (!d) return "";

  if (d.length < cfg.localMin || d.length > cfg.localMax) return "";
  return cfg.dial + d;
}

function pickUserPrimaryPhoneE164(user, countryFallback) {
  if (!user) return "";

  const direct = user.phoneE164 || user.phoneNumber || user.phone || user.mobile || "";
  const ctry = user.country || countryFallback || "";
  let e164 = normalizePhoneE164(direct, ctry);
  if (e164) return e164;

  if (Array.isArray(user.mobiles)) {
    const mm = user.mobiles.find((m) => m && (m.e164 || m.numero));
    if (mm) {
      e164 = normalizePhoneE164(mm.e164 || mm.numero, mm.country || ctry);
      if (e164) return e164;
    }
  }
  return "";
}

// ---- helper: base url (pour appeler /api/v1/phone-verification/status)
function getBaseUrlFromReq(req) {
  const envBase =
    process.env.GATEWAY_URL ||
    process.env.APP_BASE_URL ||
    process.env.GATEWAY_BASE_URL ||
    "";
  if (envBase) return String(envBase).replace(/\/+$/, "");

  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/* -------------------------------------------------------------------
 *                          Gateway config
 * ------------------------------------------------------------------- */

// 🌐 Backend principal (Users/Wallet/Notifications)
const PRINCIPAL_URL = (config.principalUrl || process.env.PRINCIPAL_URL || "").replace(/\/+$/, "");

// 🧑‍💼 ID MongoDB de l’admin (admin@paynoval.com)
const ADMIN_USER_ID = config.adminUserId || process.env.ADMIN_USER_ID || null;

/**
 * Mapping centralisé des providers -> service URL
 * ✅ Ajout override PAYNOVAL_SERVICE_URL si tu veux pointer vers une URL interne non CF
 */
const PROVIDER_TO_SERVICE = {
  paynoval: process.env.PAYNOVAL_SERVICE_URL || config.microservices?.paynoval,
  stripe: config.microservices?.stripe,
  bank: config.microservices?.bank,
  mobilemoney: config.microservices?.mobilemoney,
  visa_direct: config.microservices?.visa_direct,
  visadirect: config.microservices?.visa_direct,
  cashin: config.microservices?.cashin,
  cashout: config.microservices?.cashout,
  stripe2momo: config.microservices?.stripe2momo,
  flutterwave: config.microservices?.flutterwave,
};

function isValidObjectId(v) {
  if (!v) return false;
  return mongoose.Types.ObjectId.isValid(v) && String(v).length === 24;
}
function asObjectIdOrNull(v) {
  if (!v) return null;
  if (isValidObjectId(v)) return v;
  return null;
}

const GATEWAY_USER_AGENT =
  config.gatewayUserAgent || "PayNoval-Gateway/1.0 (+https://paynoval.com)";

function safeUUID() {
  if (crypto && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {}
  }
  return (
    Date.now().toString(16) +
    "-" +
    Math.floor(Math.random() * 0xffff).toString(16) +
    "-" +
    Math.floor(Math.random() * 0xffff).toString(16)
  );
}

function cleanSensitiveMeta(meta = {}) {
  const clone = { ...meta };
  if (clone.cardNumber) clone.cardNumber = "****" + String(clone.cardNumber).slice(-4);
  if (clone.cvc) delete clone.cvc;
  if (clone.securityCode) delete clone.securityCode;
  return clone;
}

function getUserId(req) {
  return req.user?._id || req.user?.id || null;
}

/**
 * ✅ computeProviderSelected(action,funds,destination)
 */
function computeProviderSelected(action, funds, destination) {
  const a = String(action || "").toLowerCase().trim();
  const f = String(funds || "").toLowerCase().trim();
  const d = String(destination || "").toLowerCase().trim();

  if (a === "deposit") return f;
  if (a === "withdraw") return d;
  return d; // send default
}

function resolveProvider(req, fallback = "paynoval") {
  const body = req.body || {};
  const query = req.query || {};

  const routed = req.routedProvider || req.providerSelected;
  if (routed) return String(routed).toLowerCase();

  return String(body.provider || body.destination || query.provider || fallback).toLowerCase();
}

function toIdStr(v) {
  if (!v) return "";
  try {
    if (typeof v === "string") return v;
    if (typeof v === "object" && v.toString) return v.toString();
  } catch {}
  return String(v);
}
function sameId(a, b) {
  const as = toIdStr(a);
  const bs = toIdStr(b);
  return !!as && !!bs && as === bs;
}

/**
 * ✅ Resolver STRICT du propriétaire du referral.
 */
function resolveReferralOwnerUserId(txDoc, confirmCallerUserId = null) {
  if (!txDoc) return null;

  const candidates = [
    txDoc.ownerUserId,
    txDoc.initiatorUserId,
    txDoc.fromUserId,
    txDoc.senderId,
    txDoc?.meta?.ownerUserId,
    txDoc?.meta?.initiatorUserId,
    txDoc?.meta?.fromUserId,
    txDoc?.meta?.senderId,
  ].filter(Boolean);

  if (!candidates.length) return null;

  const chosen = candidates[0];
  if (!confirmCallerUserId) return chosen;

  if (
    txDoc.receiver &&
    sameId(txDoc.receiver, confirmCallerUserId) &&
    sameId(chosen, confirmCallerUserId)
  ) {
    const alt = candidates.find((c) => !sameId(c, confirmCallerUserId));
    return alt || null;
  }

  return chosen;
}

function auditForwardHeaders(req) {
  const incomingAuth = req.headers.authorization || req.headers.Authorization || null;

  const hasAuth =
    !!incomingAuth &&
    String(incomingAuth).toLowerCase() !== "bearer null" &&
    String(incomingAuth).trim().toLowerCase() !== "null";

  const reqId = req.headers["x-request-id"] || req.id || safeUUID();
  const userId = getUserId(req) || req.headers["x-user-id"] || "";

  const internalToken =
    process.env.GATEWAY_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    config.internalToken ||
    "";

  const headers = {
    Accept: "application/json",
    "x-internal-token": internalToken,
    "x-request-id": reqId,
    "x-user-id": userId,
    "x-session-id": req.headers["x-session-id"] || "",
    ...(req.headers["x-device-id"] ? { "x-device-id": req.headers["x-device-id"] } : {}),
  };

  if (hasAuth) headers.Authorization = incomingAuth;

  return headers;
}

function isCloudflareChallengeResponse(response) {
  if (!response) return false;
  const status = response.status;
  const data = response.data;

  if (!data || typeof data !== "string") return false;
  const lower = data.toLowerCase();

  const looksLikeHtml = lower.includes("<html") || lower.includes("<!doctype html");

  const hasCloudflareMarkers =
    lower.includes("just a moment") ||
    lower.includes("attention required") ||
    lower.includes("cdn-cgi/challenge-platform") ||
    lower.includes("__cf_chl_") ||
    lower.includes("cloudflare");

  const suspiciousStatus = status === 403 || status === 429 || status === 503;

  return hasCloudflareMarkers && (suspiciousStatus || looksLikeHtml);
}

/**
 * ✅ safeAxiosRequest
 * - détecte CF/429
 * - met en cooldown par origin
 */
async function safeAxiosRequest(opts) {
  const finalOpts = { ...opts };
  if (!finalOpts.timeout) finalOpts.timeout = 15000;
  finalOpts.method = finalOpts.method || "get";

  finalOpts.headers = { ...(finalOpts.headers || {}) };
  const hasUA = finalOpts.headers["User-Agent"] || finalOpts.headers["user-agent"];
  if (!hasUA) finalOpts.headers["User-Agent"] = GATEWAY_USER_AGENT;

  // ✅ Si service en cooldown → on coupe direct
  const cd = getProviderCooldown(finalOpts.url);
  if (cd) {
    const e = new Error(`Provider cooldown (${cd.retryAfterSec}s)`);
    e.isProviderCooldown = true;
    e.cooldown = cd;
    e.response = { status: 503, data: { error: "provider_cooldown", cooldown: cd } };
    throw e;
  }

  try {
    const response = await axios(finalOpts);

    // Cloudflare HTML/challenge
    if (isCloudflareChallengeResponse(response)) {
      const cd2 = setProviderCooldown(finalOpts.url, "cloudflare_challenge", {
        retryAfterSec: 60,
      });
      const e = new Error("Cloudflare challenge détecté");
      e.response = response;
      e.isCloudflareChallenge = true;
      e.cooldown = cd2;
      throw e;
    }

    // si succès → on peut lever cooldown
    const key = getServiceKeyFromUrl(finalOpts.url);
    providerFail.delete(key);

    return response;
  } catch (err) {
    const status = err.response?.status || 502;
    const data = err.response?.data || null;
    const message = err.message || "Erreur axios inconnue";

    const preview = typeof data === "string" ? data.slice(0, 300) : data;
    const isCf = err.isCloudflareChallenge || isCloudflareChallengeResponse(err.response);
    const isRateLimited = status === 429;

    // ✅ cooldown si 429 / CF / 503 html
    if (isRateLimited || isCf) {
      const ra = Number(err.response?.headers?.["retry-after"]);
      const cd3 = setProviderCooldown(finalOpts.url, isCf ? "cloudflare_challenge" : "rate_limited", {
        retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined,
        status,
      });

      logger.warn("[Gateway][Axios] cooldown set", {
        url: finalOpts.url,
        status,
        reason: cd3.reason,
        retryAfterSec: cd3.retryAfterSec,
      });

      err.cooldown = cd3;
    }

    logger.error("[Gateway][Axios] request failed", {
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
    e.cooldown = err.cooldown;
    throw e;
  }
}

/* ---------------- OTP status helper ---------------- */
async function fetchOtpStatus({ req, phoneE164, country }) {
  const base = getBaseUrlFromReq(req);
  if (!base) return { ok: false, trusted: false, status: "unknown" };

  const url = `${base}/api/v1/phone-verification/status`;

  try {
    const r = await safeAxiosRequest({
      method: "get",
      url,
      params: { phoneNumber: phoneE164, country },
      headers: auditForwardHeaders(req),
      timeout: 8000,
    });

    const payload = r?.data || {};
    const data = payload?.data || payload;

    const status = String(data?.status || "none").toLowerCase();
    const trusted = !!data?.trusted || status === "trusted";

    return { ok: true, trusted, status, data };
  } catch (e) {
    logger?.warn?.("[Gateway][OTP] status call failed", { message: e?.message });
    return { ok: false, trusted: false, status: "unknown" };
  }
}

/* -------------------------------------------------------------------
 *           ✅ SECURITY CODE HASHING (LEGACY + PBKDF2)
 * ------------------------------------------------------------------- */

// ✅ Legacy SHA256 (compat)
function hashSecurityCodeLegacy(code) {
  return crypto.createHash("sha256").update(String(code || "").trim()).digest("hex");
}
function isLegacySha256Hex(stored) {
  return /^[a-f0-9]{64}$/i.test(String(stored || ""));
}

// ✅ Nouveau format: pbkdf2$<iter>$<saltB64>$<hashB64>
function hashSecurityCodePBKDF2(code) {
  const iterations = 180000;
  const salt = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(String(code || "").trim(), salt, iterations, 32, "sha256");
  return `pbkdf2$${iterations}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

function verifyPBKDF2(code, stored) {
  try {
    const [alg, iterStr, saltB64, hashB64] = String(stored || "").split("$");
    if (alg !== "pbkdf2") return false;
    const iterations = parseInt(iterStr, 10);
    if (!Number.isFinite(iterations) || iterations < 10000) return false;

    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const computed = crypto.pbkdf2Sync(String(code || "").trim(), salt, iterations, expected.length, "sha256");

    return expected.length === computed.length && crypto.timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

function verifySecurityCode(code, storedHash) {
  const stored = String(storedHash || "");
  if (!stored) return false;

  if (stored.startsWith("pbkdf2$")) return verifyPBKDF2(code, stored);

  if (isLegacySha256Hex(stored)) {
    const computed = hashSecurityCodeLegacy(code);
    return (
      Buffer.byteLength(computed) === Buffer.byteLength(stored.toLowerCase()) &&
      crypto.timingSafeEqual(Buffer.from(computed, "utf8"), Buffer.from(stored.toLowerCase(), "utf8"))
    );
  }

  return false;
}

function hashSecurityCode(code) {
  return hashSecurityCodePBKDF2(code);
}

/**
 * ✅ Match robuste: reference + providerTxId + meta.*
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
        body.providerTxId,
      ]
        .filter(Boolean)
        .map((v) => String(v))
    )
  );

  if (!candidates.length) return null;

  return Transaction.findOne({
    provider,
    $or: [
      ...candidates.map((v) => ({ reference: v })),
      ...candidates.map((v) => ({ providerTxId: v })),
      ...candidates.map((v) => ({ "meta.reference": v })),
      ...candidates.map((v) => ({ "meta.id": v })),
      ...candidates.map((v) => ({ "meta.providerTxId": v })),
    ],
  }).sort({ createdAt: -1 });
}

async function fetchProviderTxIdentifiers({ base, req, providerTxId }) {
  if (!base || !providerTxId) return { providerTxId: null, reference: null };

  try {
    const getResp = await safeAxiosRequest({
      method: "get",
      url: `${base}/transactions/${encodeURIComponent(String(providerTxId))}`,
      headers: auditForwardHeaders(req),
      timeout: 10000,
    });

    const full = getResp.data?.data || getResp.data || {};
    const fullRef = full.reference || full.transaction?.reference || null;
    const fullId = full.id || full._id || full.transaction?.id || providerTxId || null;

    return {
      providerTxId: fullId ? String(fullId) : String(providerTxId),
      reference: fullRef ? String(fullRef) : null,
    };
  } catch (e) {
    logger.warn("[Gateway][TX] fetchProviderTxIdentifiers failed", {
      providerTxId: String(providerTxId),
      message: e?.message,
    });
    return { providerTxId: String(providerTxId), reference: null };
  }
}

async function creditAdminCommissionFromGateway({ provider, kind, amount, currency, req }) {
  try {
    if (!PRINCIPAL_URL || !ADMIN_USER_ID) {
      logger.warn("[Gateway][Fees] PRINCIPAL_URL ou ADMIN_USER_ID manquant, commission admin non créditée.");
      return;
    }

    const num = parseFloat(amount);
    if (!num || Number.isNaN(num) || num <= 0) return;

    const url = `${PRINCIPAL_URL}/users/${ADMIN_USER_ID}/credit`;

    const authHeader = req.headers.authorization || req.headers.Authorization || null;
    const headers = {};
    if (authHeader && String(authHeader).toLowerCase().startsWith("bearer ")) {
      headers.Authorization = authHeader;
    }

    const description = `Commission PayNoval (${kind}) - provider=${provider}`;

    await safeAxiosRequest({
      method: "post",
      url,
      data: { amount: num, currency: currency || "CAD", description },
      headers,
      timeout: 10000,
    });

    logger.info("[Gateway][Fees] Crédit admin OK", {
      provider,
      kind,
      amount: num,
      currency: currency || "CAD",
      adminUserId: ADMIN_USER_ID,
    });
  } catch (err) {
    logger.error("[Gateway][Fees] Échec crédit admin", {
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
    if (provider === "paynoval") return;

    const user = req.user || {};
    const senderEmail = user.email || user.username || req.body.senderEmail || null;
    const senderName = user.fullName || user.name || req.body.senderName || senderEmail;

    const receiverEmail = result.receiverEmail || result.toEmail || req.body.toEmail || null;
    const receiverName = result.receiverName || req.body.receiverName || receiverEmail;

    if (!senderEmail && !receiverEmail) {
      logger.warn("[Gateway][TX] triggerGatewayTxEmail: aucun email sender/receiver, skip.");
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
      "---";

    const frontendBase =
      config.frontendUrl ||
      config.frontUrl ||
      (Array.isArray(config.cors?.origins) && config.cors.origins[0]) ||
      "https://www.paynoval.com";

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
      reason: type === "cancelled" ? result.reason || req.body.reason || "" : undefined,
      links: {
        sender: `${frontendBase}/transactions`,
        receiverConfirm: txId ? `${frontendBase}/transactions/confirm/${encodeURIComponent(txId)}` : "",
      },
    };

    await notifyTransactionEvent(payload);
    logger.info("[Gateway][TX] triggerGatewayTxEmail OK", { type, provider, txId, senderEmail, receiverEmail });
  } catch (err) {
    logger.error("[Gateway][TX] triggerGatewayTxEmail ERROR", { type, provider, message: err.message });
  }
}

// ✅ Extract array de transactions depuis une réponse provider (formats variés)
function extractTxArrayFromProviderPayload(payload) {
  const candidates = [
    payload?.data,
    payload?.transactions,
    payload?.data?.transactions,
    payload?.data?.data,
    payload?.result,
    payload?.items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

// ✅ Ré-injecte la liste merged dans le même format que le provider
function injectTxArrayIntoProviderPayload(payload, merged) {
  if (!payload || typeof payload !== "object") return { success: true, data: merged };

  if (Array.isArray(payload.data)) {
    payload.data = merged;
    return payload;
  }
  if (Array.isArray(payload.transactions)) {
    payload.transactions = merged;
    return payload;
  }
  if (payload.data && Array.isArray(payload.data.transactions)) {
    payload.data.transactions = merged;
    return payload;
  }
  if (payload.data && Array.isArray(payload.data.data)) {
    payload.data.data = merged;
    return payload;
  }

  payload.data = merged;
  payload.success = payload.success ?? true;
  return payload;
}

function txSortTime(tx) {
  const d = tx?.confirmedAt || tx?.completedAt || tx?.cancelledAt || tx?.createdAt || tx?.updatedAt || null;
  const t = d ? new Date(d).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}
function buildDedupKey(tx) {
  const ref = tx?.reference ? String(tx.reference) : "";
  const ptx = tx?.providerTxId ? String(tx.providerTxId) : "";
  const id = tx?._id ? String(tx._id) : tx?.id ? String(tx.id) : "";
  return ref || ptx || id || JSON.stringify(tx).slice(0, 120);
}
function mergeAndDedupTx(providerList = [], gatewayList = []) {
  const map = new Map();
  for (const tx of providerList) map.set(buildDedupKey(tx), tx);
  for (const tx of gatewayList) {
    const k = buildDedupKey(tx);
    if (!map.has(k)) map.set(k, tx);
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => txSortTime(b) - txSortTime(a));
  return merged;
}

/* -------------------------------------------------------------------
 *                       CONTROLLER ACTIONS
 * ------------------------------------------------------------------- */



// -------------------------------------------------------------------
// ✅ Mini cache anti-spam listTransactions (5–10s)
// -------------------------------------------------------------------


const LIST_TX_CACHE_TTL_MS = (() => {
  const n = Number(process.env.LIST_TX_CACHE_TTL_MS || 8000); // 8s défaut
  return Number.isFinite(n) && n >= 1000 ? n : 8000;
})();

const _listTxCache = new Map(); // key -> { expiresAt, value? {status, body}, promise? }

function _stableQueryString(obj = {}) {
  try {
    const keys = Object.keys(obj || {}).sort();
    const parts = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const it of v) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(it))}`);
      } else {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    }
    return parts.join("&");
  } catch {
    return "";
  }
}

function _listTxCacheKey({ userId, provider, query }) {
  const qs = _stableQueryString(query || {});
  return `u:${String(userId)}|p:${String(provider)}|q:${qs}`;
}

function _cacheGet(key) {
  const e = _listTxCache.get(key);
  if (!e) return null;
  if (!e.expiresAt || e.expiresAt <= Date.now()) {
    _listTxCache.delete(key);
    return null;
  }
  return e;
}

function _cacheSetPromise(key, promise) {
  _listTxCache.set(key, { expiresAt: Date.now() + LIST_TX_CACHE_TTL_MS, promise });
}

function _cacheSetValue(key, value) {
  _listTxCache.set(key, { expiresAt: Date.now() + LIST_TX_CACHE_TTL_MS, value });
}



exports.getTransaction = async (req, res) => {
  const provider = resolveProvider(req, "paynoval");
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const { id } = req.params;
  const base = String(targetService).replace(/\/+$/, "");
  const url = `${base}/transactions/${encodeURIComponent(id)}`;

  try {
    const response = await safeAxiosRequest({
      method: "get",
      url,
      headers: auditForwardHeaders(req),
      params: req.query,
      timeout: 10000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.isProviderCooldown || err.isCloudflareChallenge) {
      const cd = err.cooldown || getProviderCooldown(url);
      return res.status(503).json({
        success: false,
        error: "Service PayNoval temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
        details: err.isCloudflareChallenge ? "cloudflare_challenge" : "provider_cooldown",
        retryAfterSec: cd?.retryAfterSec,
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === "string" ? err.response.data : null) ||
      "Erreur lors du proxy GET transaction";

    if (status === 429) {
      error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.";
    }

    logger.error("[Gateway][TX] Erreur GET transaction:", { status, error, provider, transactionId: id });
    return res.status(status).json({ success: false, error });
  }
};





// exports.listTransactions = async (req, res) => {
//   const provider = resolveProvider(req, "paynoval");
//   const targetService = PROVIDER_TO_SERVICE[provider];

//   const userId = getUserId(req);
//   if (!userId) {
//     return res.status(401).json({ success: false, error: "Non autorisé." });
//   }

//   const toNum = (v, fallback) => {
//     const n = Number(v);
//     return Number.isFinite(n) ? n : fallback;
//   };

//   const normalizeListMeta = (payloadObj, mergedList) => {
//     const out = payloadObj && typeof payloadObj === "object" ? payloadObj : { success: true };
//     const limit = toNum(req.query?.limit ?? out.limit, 25);
//     const skip = toNum(req.query?.skip ?? out.skip, 0);

//     out.success = out.success ?? true;
//     out.count = mergedList.length;
//     out.total = mergedList.length;
//     out.limit = limit;
//     out.skip = skip;
//     out.items = mergedList.length;

//     return out;
//   };

//   // ✅ Gateway DB always available
//   const gatewayQuery = {
//     provider,
//     $or: [{ userId }, { ownerUserId: userId }, { initiatorUserId: userId }, { createdBy: userId }, { receiver: userId }],
//   };

//   let gatewayTx = [];
//   try {
//     gatewayTx = await Transaction.find(gatewayQuery)
//       .select("-securityCodeHash -securityQuestion")
//       .sort({ createdAt: -1 })
//       .limit(300)
//       .lean();

//     gatewayTx = (gatewayTx || []).map((t) => ({
//       ...t,
//       id: t?._id ? String(t._id) : t?.id,
//     }));
//   } catch (e) {
//     logger.warn("[Gateway][TX] listTransactions: failed to read gateway DB", { message: e?.message });
//     gatewayTx = [];
//   }

//   // Pas de provider service => return DB only
//   if (!targetService) {
//     return res.status(200).json({
//       success: true,
//       data: gatewayTx,
//       count: gatewayTx.length,
//       total: gatewayTx.length,
//       limit: toNum(req.query?.limit, 25),
//       skip: toNum(req.query?.skip, 0),
//       warning: "no_provider_service",
//     });
//   }

//   const base = String(targetService).replace(/\/+$/, "");
//   const url = `${base}/transactions`;

//   // ✅ Si cooldown actif => on skip provider direct
//   const cdBefore = getProviderCooldown(url);
//   if (cdBefore) {
//     return res.status(200).json({
//       success: true,
//       data: gatewayTx,
//       count: gatewayTx.length,
//       total: gatewayTx.length,
//       limit: toNum(req.query?.limit, 25),
//       skip: toNum(req.query?.skip, 0),
//       warning: "provider_cooldown",
//       retryAfterSec: cdBefore.retryAfterSec,
//     });
//   }

//   try {
//     const response = await safeAxiosRequest({
//       method: "get",
//       url,
//       headers: auditForwardHeaders(req),
//       params: req.query,
//       timeout: 15000,
//     });

//     const payload = response.data || {};
//     const providerList = extractTxArrayFromProviderPayload(payload);

//     const merged = mergeAndDedupTx(providerList, gatewayTx);

//     let finalPayload = injectTxArrayIntoProviderPayload(payload, merged);
//     finalPayload = normalizeListMeta(finalPayload, merged);

//     return res.status(response.status).json(finalPayload);
//   } catch (err) {
//     if (err.isProviderCooldown || err.isCloudflareChallenge) {
//       const cd = err.cooldown || getProviderCooldown(url);
//       return res.status(200).json({
//         success: true,
//         data: gatewayTx,
//         count: gatewayTx.length,
//         total: gatewayTx.length,
//         limit: toNum(req.query?.limit, 25),
//         skip: toNum(req.query?.skip, 0),
//         warning: err.isCloudflareChallenge ? "provider_cloudflare_challenge" : "provider_cooldown",
//         retryAfterSec: cd?.retryAfterSec,
//       });
//     }

//     const status = err.response?.status || 502;
//     let error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       (typeof err.response?.data === "string" ? err.response.data : null) ||
//       "Erreur lors du proxy GET transactions";

//     if (status === 429) {
//       error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants.";
//     }

//     logger.error("[Gateway][TX] Erreur GET transactions (fallback gateway DB)", { status, error, provider });

//     return res.status(200).json({
//       success: true,
//       data: gatewayTx,
//       count: gatewayTx.length,
//       total: gatewayTx.length,
//       limit: toNum(req.query?.limit, 25),
//       skip: toNum(req.query?.skip, 0),
//       warning: "provider_unavailable",
//     });
//   }
// };




exports.listTransactions = async (req, res) => {
  const provider = resolveProvider(req, "paynoval");
  const targetService = PROVIDER_TO_SERVICE[provider];

  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: "Non autorisé." });
  }

  // ✅ clé cache par user + provider + query
  const cacheKey = _listTxCacheKey({ userId, provider, query: req.query });

  // 1) cache HIT (value)
  const hit = _cacheGet(cacheKey);
  if (hit?.value) {
    return res.status(hit.value.status).json(hit.value.body);
  }

  // 2) in-flight (promise) -> attendre le même résultat
  if (hit?.promise) {
    try {
      const out = await hit.promise;
      return res.status(out.status).json(out.body);
    } catch {
      // si promise a crash, on continue en recalcul
      _listTxCache.delete(cacheKey);
    }
  }

  const compute = async () => {
    const toNum = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    const normalizeListMeta = (payloadObj, mergedList) => {
      const out = payloadObj && typeof payloadObj === "object" ? payloadObj : { success: true };
      const limit = toNum(req.query?.limit ?? out.limit, 25);
      const skip = toNum(req.query?.skip ?? out.skip, 0);

      out.success = out.success ?? true;
      out.count = mergedList.length;
      out.total = mergedList.length;
      out.limit = limit;
      out.skip = skip;
      out.items = mergedList.length;

      return out;
    };

    // ✅ Gateway DB always available
    const gatewayQuery = {
      provider,
      $or: [{ userId }, { ownerUserId: userId }, { initiatorUserId: userId }, { createdBy: userId }, { receiver: userId }],
    };

    let gatewayTx = [];
    try {
      gatewayTx = await Transaction.find(gatewayQuery)
        .select("-securityCodeHash -securityQuestion")
        .sort({ createdAt: -1 })
        .limit(300)
        .lean();

      gatewayTx = (gatewayTx || []).map((t) => ({
        ...t,
        id: t?._id ? String(t._id) : t?.id,
      }));
    } catch (e) {
      logger.warn("[Gateway][TX] listTransactions: failed to read gateway DB", { message: e?.message });
      gatewayTx = [];
    }

    // Pas de provider service => return DB only
    if (!targetService) {
      return {
        status: 200,
        body: {
          success: true,
          data: gatewayTx,
          count: gatewayTx.length,
          total: gatewayTx.length,
          limit: toNum(req.query?.limit, 25),
          skip: toNum(req.query?.skip, 0),
          warning: "no_provider_service",
        },
      };
    }

    const base = String(targetService).replace(/\/+$/, "");
    const url = `${base}/transactions`;

    // ✅ Si cooldown actif => on skip provider direct
    const cdBefore = getProviderCooldown(url);
    if (cdBefore) {
      return {
        status: 200,
        body: {
          success: true,
          data: gatewayTx,
          count: gatewayTx.length,
          total: gatewayTx.length,
          limit: toNum(req.query?.limit, 25),
          skip: toNum(req.query?.skip, 0),
          warning: "provider_cooldown",
          retryAfterSec: cdBefore.retryAfterSec,
        },
      };
    }

    try {
      const response = await safeAxiosRequest({
        method: "get",
        url,
        headers: auditForwardHeaders(req),
        params: req.query,
        timeout: 15000,
      });

      const payload = response.data || {};
      const providerList = extractTxArrayFromProviderPayload(payload);

      const merged = mergeAndDedupTx(providerList, gatewayTx);

      let finalPayload = injectTxArrayIntoProviderPayload(payload, merged);
      finalPayload = normalizeListMeta(finalPayload, merged);

      return { status: response.status, body: finalPayload };
    } catch (err) {
      if (err.isProviderCooldown || err.isCloudflareChallenge) {
        const cd = err.cooldown || getProviderCooldown(url);
        return {
          status: 200,
          body: {
            success: true,
            data: gatewayTx,
            count: gatewayTx.length,
            total: gatewayTx.length,
            limit: toNum(req.query?.limit, 25),
            skip: toNum(req.query?.skip, 0),
            warning: err.isCloudflareChallenge ? "provider_cloudflare_challenge" : "provider_cooldown",
            retryAfterSec: cd?.retryAfterSec,
          },
        };
      }

      const status = err.response?.status || 502;
      let error =
        err.response?.data?.error ||
        err.response?.data?.message ||
        (typeof err.response?.data === "string" ? err.response.data : null) ||
        "Erreur lors du proxy GET transactions";

      if (status === 429) {
        error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants.";
      }

      logger.error("[Gateway][TX] Erreur GET transactions (fallback gateway DB)", { status, error, provider });

      return {
        status: 200,
        body: {
          success: true,
          data: gatewayTx,
          count: gatewayTx.length,
          total: gatewayTx.length,
          limit: toNum(req.query?.limit, 25),
          skip: toNum(req.query?.skip, 0),
          warning: "provider_unavailable",
        },
      };
    }
  };

  // ✅ Anti-spam : une seule exécution pour les requêtes identiques (in-flight)
  const promise = (async () => {
    try {
      const out = await compute();
      _cacheSetValue(cacheKey, out); // cache résultat
      return out;
    } catch (e) {
      _listTxCache.delete(cacheKey); // pas de cache en cas de crash inattendu
      throw e;
    }
  })();

  _cacheSetPromise(cacheKey, promise);

  const out = await promise;
  return res.status(out.status).json(out.body);
};




/**
 * POST /transactions/initiate
 * ✅ Routing basé sur providerSelected (req.routedProvider)
 * ✅ Stocke action/funds/destination/providerSelected dans la TX gateway
 *
 * OTP (PayNoval): dépôt MobileMoney -> PayNoval sur numéro différent
 * => autorisé uniquement si numéro "trusted" (OTP validé)
 */
exports.initiateTransaction = async (req, res) => {
  const actionTx = String(req.body?.action || "send").toLowerCase();
  const funds = req.body?.funds;
  const destination = req.body?.destination;

  const providerSelected = resolveProvider(req, computeProviderSelected(actionTx, funds, destination));

  const targetService = PROVIDER_TO_SERVICE[providerSelected];
  const base = targetService ? String(targetService).replace(/\/+$/, "") : null;
  const targetUrl = base ? base + "/transactions/initiate" : null;

  if (!targetUrl) {
    return res.status(400).json({ success: false, error: "Provider (providerSelected) inconnu." });
  }

  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: "Non autorisé (utilisateur manquant)." });
  }

  // ✅ Guard OTP : dépôt MobileMoney -> PayNoval sur un numéro différent
  try {
    const actionNorm = String(req.body?.action || "send").toLowerCase();
    const fundsNorm = String(req.body?.funds || "").toLowerCase();
    const destNorm = String(req.body?.destination || "").toLowerCase();

    if (actionNorm === "deposit" && fundsNorm === "mobilemoney" && destNorm === "paynoval") {
      const rawPhone = req.body?.phoneNumber || req.body?.toPhone || req.body?.phone || "";
      const country = req.body?.country || req.user?.country || req.user?.selectedCountry || "";

      const phoneE164 = normalizePhoneE164(rawPhone, country);

      if (!phoneE164) {
        return res.status(400).json({
          success: false,
          error:
            "Numéro de dépôt invalide. Format attendu: E.164 (ex: +2250700000000) ou numéro local valide selon le pays.",
          code: "PHONE_INVALID",
        });
      }

      // Même numéro que le user => OK sans trusted
      const userPhoneE164 = pickUserPrimaryPhoneE164(req.user, country);
      const isSameAsUser = userPhoneE164 && String(userPhoneE164) === String(phoneE164);

      if (!isSameAsUser) {
        // 1) DB trusted
        const trustedDoc = await TrustedDepositNumber.findOne({
          userId,
          phoneE164,
          status: "trusted",
        }).lean();

        if (!trustedDoc) {
          // 2) status API
          const st = await fetchOtpStatus({ req, phoneE164, country });

          // trusted => upsert
          if (st?.trusted) {
            try {
              await TrustedDepositNumber.updateOne(
                { userId, phoneE164 },
                {
                  $set: { userId, phoneE164, status: "trusted", verifiedAt: new Date(), updatedAt: new Date() },
                  $setOnInsert: { createdAt: new Date() },
                },
                { upsert: true }
              );
            } catch {}
          } else {
            // pending => ne pas start
            if (String(st?.status || "").toLowerCase() === "pending") {
              return res.status(403).json({
                success: false,
                error:
                  "Vérification SMS déjà en cours pour ce numéro. Entre le code reçu (ne relance pas l’OTP).",
                code: "PHONE_VERIFICATION_PENDING",
                otpStatus: { status: "pending", skipStart: true },
                nextStep: {
                  status: "/api/v1/phone-verification/status",
                  start: "/api/v1/phone-verification/start",
                  verify: "/api/v1/phone-verification/verify",
                  phoneNumber: phoneE164,
                  country,
                  skipStart: true,
                },
              });
            }

            // none/unknown => start
            return res.status(403).json({
              success: false,
              error: "Ce numéro n’est pas vérifié. Vérifie d’abord le numéro par SMS avant de déposer.",
              code: "PHONE_NOT_TRUSTED",
              otpStatus: { status: st?.status || "none", skipStart: false },
              nextStep: {
                status: "/api/v1/phone-verification/status",
                start: "/api/v1/phone-verification/start",
                verify: "/api/v1/phone-verification/verify",
                phoneNumber: phoneE164,
                country,
                skipStart: false,
              },
            });
          }
        }
      }

      // ✅ réécriture E.164
      req.body.phoneNumber = phoneE164;
    }
  } catch (e) {
    logger?.warn?.("[Gateway][OTP] trusted check failed", { message: e?.message });
    return res.status(500).json({ success: false, error: "Erreur vérification numéro." });
  }

  const now = new Date();

  // ✅ sécurité (soft)
  const securityQuestion = (req.body.securityQuestion || req.body.question || "").trim();
  const securityCode = (req.body.securityCode || "").trim();

  const shouldUseSecurity =
    (actionTx === "send" || actionTx === "withdraw") && !!securityQuestion && !!securityCode;

  const requiresSecurityValidation = !!shouldUseSecurity;
  const securityCodeHash = shouldUseSecurity ? hashSecurityCode(securityCode) : undefined;

  try {
    const response = await safeAxiosRequest({
      method: "post",
      url: targetUrl,
      data: req.body,
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    const result = response.data || {};

    const reference = result.reference || result.transaction?.reference || null;
    const providerTxId = result.id || result.transactionId || result.transaction?.id || null;

    const finalReference = reference || (providerTxId ? String(providerTxId) : null);
    const statusResult = result.status || "pending";

    await AMLLog.create({
      userId,
      type: "initiate",
      provider: providerSelected,
      amount: req.body.amount,
      toEmail: req.body.toEmail || "",
      details: cleanSensitiveMeta(req.body),
      flagged: req.amlFlag || false,
      flagReason: req.amlReason || "",
      createdAt: now,
    });

    await Transaction.create({
      userId,
      ownerUserId: userId,
      initiatorUserId: userId,
      provider: providerSelected,

      action: actionTx,
      funds: req.body.funds,
      destination: req.body.destination,
      providerSelected,

      amount: Number(req.body.amount),
      status: statusResult,

      toEmail: req.body.toEmail || undefined,
      toIBAN: req.body.iban || undefined,
      toPhone: req.body.phoneNumber || undefined,

      currency: req.body.currency || req.body.senderCurrencySymbol || req.body.localCurrencySymbol || undefined,
      operator: req.body.operator || undefined,
      country: req.body.country || undefined,

      reference: finalReference,
      providerTxId: providerTxId ? String(providerTxId) : undefined,

      meta: {
        ...cleanSensitiveMeta(req.body),
        reference: finalReference || "",
        id: providerTxId ? String(providerTxId) : undefined,
        providerTxId: providerTxId ? String(providerTxId) : undefined,
        ownerUserId: toIdStr(userId),
        initiatorUserId: toIdStr(userId),
        action: actionTx,
        funds: req.body.funds,
        destination: req.body.destination,
        providerSelected,
      },

      createdAt: now,
      updatedAt: now,

      requiresSecurityValidation,
      securityQuestion: requiresSecurityValidation ? securityQuestion : undefined,
      securityCodeHash: requiresSecurityValidation ? securityCodeHash : undefined,
      securityAttempts: 0,
      securityLockedUntil: null,
    });

    await triggerGatewayTxEmail("initiated", { provider: providerSelected, req, result, reference: finalReference });

    if (providerSelected !== "paynoval") {
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
              "CAD";

            await creditAdminCommissionFromGateway({
              provider: providerSelected,
              kind: "transaction",
              amount: feeAmount,
              currency: feeCurrency,
              req,
            });
          }
        }
      } catch (e) {
        logger?.error?.("[Gateway][Fees] Erreur crédit admin (initiate)", { provider: providerSelected, message: e.message });
      }
    }

    return res.status(response.status).json(result);
  } catch (err) {
    if (err.isProviderCooldown || err.isCloudflareChallenge) {
      const cd = err.cooldown || getProviderCooldown(targetUrl);
      return res.status(503).json({
        success: false,
        error: "Service PayNoval temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
        details: err.isCloudflareChallenge ? "cloudflare_challenge" : "provider_cooldown",
        retryAfterSec: cd?.retryAfterSec,
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === "string" ? err.response.data : null) ||
      err.message ||
      "Erreur interne provider";

    if (status === 429) {
      error = "Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.";
    }

    try {
      await AMLLog.create({
        userId,
        type: "initiate",
        provider: providerSelected,
        amount: req.body.amount,
        toEmail: req.body.toEmail || "",
        details: cleanSensitiveMeta({ ...req.body, error }),
        flagged: req.amlFlag || false,
        flagReason: req.amlReason || "",
        createdAt: now,
      });

      await Transaction.create({
        userId,
        ownerUserId: userId,
        initiatorUserId: userId,
        provider: providerSelected,

        action: actionTx,
        funds: req.body.funds,
        destination: req.body.destination,
        providerSelected,

        amount: req.body.amount,
        status: "failed",

        toEmail: req.body.toEmail || undefined,
        toIBAN: req.body.iban || undefined,
        toPhone: req.body.phoneNumber || undefined,

        currency: req.body.currency || req.body.senderCurrencySymbol || req.body.localCurrencySymbol || undefined,
        operator: req.body.operator || undefined,
        country: req.body.country || undefined,

        reference: null,
        meta: {
          ...cleanSensitiveMeta({ ...req.body, error }),
          ownerUserId: toIdStr(userId),
          initiatorUserId: toIdStr(userId),
          action: actionTx,
          funds: req.body.funds,
          destination: req.body.destination,
          providerSelected,
        },
        createdAt: now,
        updatedAt: now,
      });
    } catch {}

    logger?.error?.("[Gateway][TX] initiateTransaction failed", { provider: providerSelected, error, status });
    return res.status(status).json({ success: false, error });
  }
};

/**
 * POST /transactions/confirm
 * (ton code conservé; juste profite du safeAxiosRequest cooldown)
 */
exports.confirmTransaction = async (req, res) => {
  const provider = resolveProvider(req, "paynoval");
  const { transactionId, securityCode } = req.body || {};

  const targetService = PROVIDER_TO_SERVICE[provider];
  const base = targetService ? String(targetService).replace(/\/+$/, "") : null;
  const targetUrl = base ? base + "/transactions/confirm" : null;

  if (!targetUrl) {
    return res.status(400).json({ success: false, error: "Provider (destination) inconnu." });
  }

  const confirmCallerUserId = getUserId(req);
  const now = new Date();

  let txRecord = await findGatewayTxForConfirm(provider, transactionId, req.body);

  if (!txRecord && base && transactionId) {
    const ids = await fetchProviderTxIdentifiers({ base, req, providerTxId: transactionId });
    if (ids?.reference || ids?.providerTxId) {
      txRecord = await findGatewayTxForConfirm(provider, ids.providerTxId || transactionId, {
        ...req.body,
        reference: ids.reference || undefined,
        providerTxId: ids.providerTxId || undefined,
      });
    }
  }

  const normalizeStatus = (raw) => {
    const s = String(raw || "").toLowerCase().trim();
    if (s === "cancelled" || s === "canceled") return "canceled";
    if (s === "confirmed" || s === "success" || s === "validated" || s === "completed") return "confirmed";
    if (s === "failed" || s === "error" || s === "declined" || s === "rejected") return "failed";
    if (s === "pending" || s === "processing" || s === "in_progress") return "pending";
    return s || "confirmed";
  };

  if (provider !== "paynoval") {
    if (!txRecord) {
      return res.status(404).json({ success: false, error: "Transaction non trouvée dans le Gateway." });
    }

    if (txRecord.status !== "pending") {
      return res.status(400).json({ success: false, error: "Transaction déjà traitée ou annulée." });
    }

    if (txRecord.requiresSecurityValidation && txRecord.securityCodeHash) {
      if (txRecord.securityLockedUntil && txRecord.securityLockedUntil > now) {
        return res.status(423).json({
          success: false,
          error: "Transaction temporairement bloquée suite à des tentatives infructueuses. Réessayez plus tard.",
        });
      }

      if (!securityCode) {
        return res.status(400).json({ success: false, error: "securityCode requis pour confirmer cette transaction." });
      }

      if (!verifySecurityCode(securityCode, txRecord.securityCodeHash)) {
        const attempts = (txRecord.securityAttempts || 0) + 1;
        const update = { securityAttempts: attempts, updatedAt: now };
        let errorMsg;

        if (attempts >= 3) {
          update.status = "canceled";
          update.cancelledAt = now;
          update.cancelReason = "Code de sécurité erroné (trop d’essais)";
          update.securityLockedUntil = new Date(now.getTime() + 15 * 60 * 1000);

          errorMsg = "Code de sécurité incorrect. Nombre d’essais dépassé, transaction annulée.";

          await triggerGatewayTxEmail("cancelled", {
            provider,
            req,
            result: { ...(txRecord.toObject ? txRecord.toObject() : txRecord), status: "canceled" },
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
        { $set: { securityAttempts: 0, securityLockedUntil: null, updatedAt: now } }
      );
    }
  }

  try {
    const response = await safeAxiosRequest({
      method: "post",
      url: targetUrl,
      data: req.body,
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    const result = response.data || {};
    const newStatus = normalizeStatus(result.status || "confirmed");

    const refFromResult = result.reference || result.transaction?.reference || req.body.reference || null;
    const idFromResult = result.id || result.transaction?.id || result.transactionId || transactionId || null;

    const candidates = Array.from(
      new Set(
        [
          refFromResult,
          idFromResult,
          transactionId,
          txRecord?.reference,
          txRecord?.providerTxId,
          txRecord?.meta?.reference,
          txRecord?.meta?.id,
          txRecord?.meta?.providerTxId,
        ]
          .filter(Boolean)
          .map(String)
      )
    );

    await AMLLog.create({
      userId: confirmCallerUserId,
      type: "confirm",
      provider,
      amount: result.amount || 0,
      toEmail: result.recipientEmail || result.toEmail || result.email || "",
      details: cleanSensitiveMeta(req.body),
      flagged: false,
      flagReason: "",
      createdAt: now,
    });

    const query = {
      provider,
      $or: [
        ...candidates.map((v) => ({ reference: v })),
        ...candidates.map((v) => ({ providerTxId: v })),
        ...candidates.map((v) => ({ "meta.reference": v })),
        ...candidates.map((v) => ({ "meta.id": v })),
        ...candidates.map((v) => ({ "meta.providerTxId": v })),
      ],
    };

    const resilientOwnerUserId =
      txRecord?.ownerUserId || txRecord?.initiatorUserId || txRecord?.meta?.ownerUserId || txRecord?.userId || null;

    const patch = {
      status: newStatus,
      confirmedAt: newStatus === "confirmed" ? now : undefined,
      cancelledAt: newStatus === "canceled" ? now : undefined,
      updatedAt: now,

      providerTxId: idFromResult ? String(idFromResult) : undefined,
      ...(refFromResult ? { reference: String(refFromResult) } : {}),

      ...(resilientOwnerUserId ? { ownerUserId: resilientOwnerUserId } : {}),
      ...(resilientOwnerUserId ? { initiatorUserId: txRecord?.initiatorUserId || resilientOwnerUserId } : {}),

      meta: {
        ...(txRecord?.meta || {}),
        ...(idFromResult ? { id: String(idFromResult), providerTxId: String(idFromResult) } : {}),
        ...(refFromResult ? { reference: String(refFromResult) } : {}),
        ...(resilientOwnerUserId ? { ownerUserId: toIdStr(resilientOwnerUserId) } : {}),
        ...(resilientOwnerUserId
          ? { initiatorUserId: toIdStr(txRecord?.initiatorUserId || resilientOwnerUserId) }
          : {}),
      },
    };

    let gatewayTx = null;
    if (txRecord?._id) {
      gatewayTx = await Transaction.findByIdAndUpdate(txRecord._id, { $set: patch }, { new: true });
    } else {
      gatewayTx = await Transaction.findOneAndUpdate(query, { $set: patch }, { new: true });
    }

    if (!gatewayTx && base && idFromResult) {
      const ids = await fetchProviderTxIdentifiers({ base, req, providerTxId: idFromResult });
      if (ids?.reference) {
        gatewayTx = await Transaction.findOneAndUpdate(
          {
            provider,
            $or: [
              { reference: String(ids.reference) },
              { "meta.reference": String(ids.reference) },
              { providerTxId: String(idFromResult) },
              { "meta.id": String(idFromResult) },
              { "meta.providerTxId": String(idFromResult) },
            ],
          },
          { $set: { ...patch, reference: String(ids.reference), meta: { ...(patch.meta || {}), reference: String(ids.reference) } } },
          { new: true }
        );
      }
    }

    if (newStatus === "confirmed") {
      await triggerGatewayTxEmail("confirmed", { provider, req, result, reference: refFromResult || transactionId });
    } else if (newStatus === "canceled") {
      await triggerGatewayTxEmail("cancelled", { provider, req, result, reference: refFromResult || transactionId });
    } else if (newStatus === "failed") {
      await triggerGatewayTxEmail("failed", { provider, req, result, reference: refFromResult || transactionId });
    }

    if (newStatus === "confirmed") {
      const referralUserId = resolveReferralOwnerUserId(gatewayTx || txRecord, confirmCallerUserId);

      if (!referralUserId) {
        logger.warn("[Gateway][TX][Referral] owner introuvable/ambigu => SKIP", {
          provider,
          transactionId,
          gatewayTxId: gatewayTx?._id,
          confirmCallerUserId: confirmCallerUserId ? toIdStr(confirmCallerUserId) : null,
        });
      } else {
        try {
          const txForReferral = {
            id: String(idFromResult || refFromResult || transactionId || ""),
            reference: refFromResult ? String(refFromResult) : gatewayTx?.reference ? String(gatewayTx.reference) : "",
            status: "confirmed",
            amount: Number(result.amount || gatewayTx?.amount || txRecord?.amount || 0),
            currency: String(result.currency || gatewayTx?.currency || txRecord?.currency || req.body.currency || "CAD"),
            country: String(result.country || gatewayTx?.country || txRecord?.country || req.body.country || ""),
            provider: String(provider),
            createdAt: (gatewayTx?.createdAt || txRecord?.createdAt)
              ? new Date(gatewayTx?.createdAt || txRecord?.createdAt).toISOString()
              : new Date().toISOString(),
            confirmedAt: new Date().toISOString(),
            ownerUserId: toIdStr(referralUserId),
            confirmCallerUserId: confirmCallerUserId ? toIdStr(confirmCallerUserId) : null,
          };

          await checkAndGenerateReferralCodeInMain(referralUserId, null, txForReferral);
          await processReferralBonusIfEligible(referralUserId, null);
        } catch (e) {
          logger.warn("[Gateway][TX][Referral] referral utils failed", { referralUserId: toIdStr(referralUserId), message: e?.message });
        }

        try {
          await notifyReferralOnConfirm({
            userId: referralUserId,
            provider,
            transaction: {
              id: String(idFromResult || refFromResult || transactionId || ""),
              reference: refFromResult ? String(refFromResult) : gatewayTx?.reference ? String(gatewayTx.reference) : "",
              amount: Number(result.amount || gatewayTx?.amount || txRecord?.amount || 0),
              currency: String(result.currency || gatewayTx?.currency || txRecord?.currency || req.body.currency || "CAD"),
              country: String(result.country || gatewayTx?.country || txRecord?.country || req.body.country || ""),
              provider: String(provider),
              confirmedAt: new Date().toISOString(),
            },
            requestId: req.id,
          });
        } catch (e) {
          logger.warn("[Gateway][Referral] notifyReferralOnConfirm failed", { message: e?.message });
        }
      }
    }

    return res.status(response.status).json(result);
  } catch (err) {
    if (err.isProviderCooldown || err.isCloudflareChallenge) {
      const cd = err.cooldown || getProviderCooldown(targetUrl);
      return res.status(503).json({
        success: false,
        error: "Service PayNoval temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
        details: err.isCloudflareChallenge ? "cloudflare_challenge" : "provider_cooldown",
        retryAfterSec: cd?.retryAfterSec,
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === "string" ? err.response.data : null) ||
      err.message ||
      "Erreur interne provider";

    if (status === 429) {
      error = "Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.";
    }

    await AMLLog.create({
      userId: confirmCallerUserId,
      type: "confirm",
      provider,
      amount: 0,
      toEmail: "",
      details: cleanSensitiveMeta({ ...req.body, error }),
      flagged: false,
      flagReason: "",
      createdAt: now,
    });

    await Transaction.findOneAndUpdate(
      {
        provider,
        $or: [
          { reference: String(transactionId) },
          { providerTxId: String(transactionId) },
          { "meta.reference": String(transactionId) },
          { "meta.id": String(transactionId) },
          { "meta.providerTxId": String(transactionId) },
        ],
      },
      { $set: { status: "failed", updatedAt: now } }
    );

    logger.error("[Gateway][TX] confirmTransaction failed", { provider, error, status });
    return res.status(status).json({ success: false, error });
  }
};

/**
 * POST /transactions/cancel
 */
exports.cancelTransaction = async (req, res) => {
  const provider = resolveProvider(req, "paynoval");
  const { transactionId } = req.body || {};

  const targetService = PROVIDER_TO_SERVICE[provider];
  const base = targetService ? String(targetService).replace(/\/+$/, "") : null;
  const targetUrl = base ? base + "/transactions/cancel" : null;

  if (!targetUrl) {
    return res.status(400).json({ success: false, error: "Provider (destination) inconnu." });
  }

  const userId = getUserId(req);
  const now = new Date();

  try {
    const response = await safeAxiosRequest({
      method: "post",
      url: targetUrl,
      data: req.body,
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    const result = response.data || {};
    const newStatus = result.status || "canceled";

    await AMLLog.create({
      userId,
      type: "cancel",
      provider,
      amount: result.amount || 0,
      toEmail: result.toEmail || "",
      details: cleanSensitiveMeta(req.body),
      flagged: false,
      flagReason: "",
      createdAt: now,
    });

    await Transaction.findOneAndUpdate(
      {
        provider,
        $or: [
          { reference: String(transactionId) },
          { providerTxId: String(transactionId) },
          { "meta.reference": String(transactionId) },
          { "meta.id": String(transactionId) },
          { "meta.providerTxId": String(transactionId) },
        ],
      },
      {
        $set: {
          status: newStatus,
          cancelledAt: now,
          cancelReason: req.body.reason || result.reason || "",
          updatedAt: now,
        },
      }
    );

    await triggerGatewayTxEmail("cancelled", { provider, req, result, reference: transactionId });

    if (provider !== "paynoval") {
      try {
        const rawCancellationFee = result.cancellationFeeInSenderCurrency || result.cancellationFee || result.fees || null;

        if (rawCancellationFee) {
          const feeAmount = parseFloat(rawCancellationFee);
          if (!Number.isNaN(feeAmount) && feeAmount > 0) {
            const feeCurrency =
              result.adminCurrency || result.currency || req.body.currency || req.body.senderCurrencySymbol || "CAD";

            await creditAdminCommissionFromGateway({
              provider,
              kind: "cancellation",
              amount: feeAmount,
              currency: feeCurrency,
              req,
            });
          }
        }
      } catch (e) {
        logger.error("[Gateway][Fees] Erreur crédit admin (cancel)", { provider, message: e.message });
      }
    }

    return res.status(response.status).json(result);
  } catch (err) {
    if (err.isProviderCooldown || err.isCloudflareChallenge) {
      const cd = err.cooldown || getProviderCooldown(targetUrl);
      return res.status(503).json({
        success: false,
        error: "Service de paiement temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
        details: err.isCloudflareChallenge ? "cloudflare_challenge" : "provider_cooldown",
        retryAfterSec: cd?.retryAfterSec,
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === "string" ? err.response.data : null) ||
      err.message ||
      "Erreur interne provider";

    if (status === 429) {
      error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.";
    }

    await AMLLog.create({
      userId,
      type: "cancel",
      provider,
      amount: 0,
      toEmail: "",
      details: cleanSensitiveMeta({ ...req.body, error }),
      flagged: false,
      flagReason: "",
      createdAt: now,
    });

    await Transaction.findOneAndUpdate(
      {
        provider,
        $or: [
          { reference: String(transactionId) },
          { providerTxId: String(transactionId) },
          { "meta.reference": String(transactionId) },
          { "meta.id": String(transactionId) },
          { "meta.providerTxId": String(transactionId) },
        ],
      },
      { $set: { status: "failed", updatedAt: now } }
    );

    logger.error("[Gateway][TX] cancelTransaction failed", { provider, error, status });
    return res.status(status).json({ success: false, error });
  }
};

/**
 * ✅ Route interne log
 */
exports.logInternalTransaction = async (req, res) => {
  try {
    const now = new Date();

    const authUserId = getUserId(req);
    const bodyUserId = req.body?.userId;

    const finalUserId = asObjectIdOrNull(authUserId) || asObjectIdOrNull(bodyUserId);
    if (!finalUserId) {
      return res.status(400).json({
        success: false,
        error: "userId manquant ou invalide (ObjectId requis) pour loguer la transaction.",
      });
    }

    const {
      provider = "paynoval",
      amount,
      status = "confirmed",
      currency,
      operator = "paynoval",
      country,
      reference,
      meta = {},
      createdBy,
      receiver,
      fees,
      netAmount,
      ownerUserId,
      initiatorUserId,
      providerTxId,
    } = req.body || {};

    const numAmount = Number(amount);
    if (!numAmount || Number.isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, error: "amount invalide ou manquant pour loguer la transaction." });
    }

    const createdById = asObjectIdOrNull(createdBy) || finalUserId;
    const receiverId = asObjectIdOrNull(receiver) || null;

    const ownerId = asObjectIdOrNull(ownerUserId) || asObjectIdOrNull(initiatorUserId) || createdById;
    const initiatorId = asObjectIdOrNull(initiatorUserId) || asObjectIdOrNull(ownerUserId) || createdById;

    const receiverRaw = receiver && !receiverId ? receiver : undefined;
    const createdByRaw = createdBy && !asObjectIdOrNull(createdBy) ? createdBy : undefined;

    const tx = await Transaction.create({
      userId: finalUserId,
      ownerUserId: ownerId,
      initiatorUserId: initiatorId,

      provider,
      amount: numAmount,
      status,
      currency,
      operator,
      country,
      reference,
      providerTxId: providerTxId ? String(providerTxId) : undefined,

      requiresSecurityValidation: false,
      securityAttempts: 0,
      securityLockedUntil: null,

      confirmedAt: status === "confirmed" ? now : undefined,

      meta: {
        ...cleanSensitiveMeta(meta),
        ownerUserId: toIdStr(ownerId),
        initiatorUserId: toIdStr(initiatorId),
        ...(receiverRaw ? { receiverRaw } : {}),
        ...(createdByRaw ? { createdByRaw } : {}),
      },

      createdAt: now,
      updatedAt: now,

      createdBy: createdById,
      receiver: receiverId || undefined,

      fees: typeof fees === "number" ? fees : fees != null ? Number(fees) : undefined,
      netAmount: typeof netAmount === "number" ? netAmount : netAmount != null ? Number(netAmount) : undefined,
    });

    return res.status(201).json({ success: true, data: tx });
  } catch (err) {
    logger.error("[Gateway][TX] logInternalTransaction error", { message: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: "Erreur lors de la création de la transaction interne." });
  }
};

exports.refundTransaction = async (req, res) => forwardTransactionProxy(req, res, "refund");
exports.reassignTransaction = async (req, res) => forwardTransactionProxy(req, res, "reassign");
exports.validateTransaction = async (req, res) => forwardTransactionProxy(req, res, "validate");
exports.archiveTransaction = async (req, res) => forwardTransactionProxy(req, res, "archive");
exports.relaunchTransaction = async (req, res) => forwardTransactionProxy(req, res, "relaunch");




async function forwardTransactionProxy(req, res, action) {
  const provider = resolveProvider(req, "paynoval");
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const url = String(targetService).replace(/\/+$/, "") + `/transactions/${action}`;

  try {
    const response = await safeAxiosRequest({
      method: "post",
      url,
      data: req.body,
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.isProviderCooldown || err.isCloudflareChallenge) {
      const cd = err.cooldown || getProviderCooldown(url);
      return res.status(503).json({
        success: false,
        error: "Service PayNoval temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
        details: err.isCloudflareChallenge ? "cloudflare_challenge" : "provider_cooldown",
        retryAfterSec: cd?.retryAfterSec,
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === "string" ? err.response.data : null) ||
      err.message ||
      `Erreur proxy ${action}`;

    if (status === 429) {
      error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.";
    }

    logger.error(`[Gateway][TX] Erreur ${action}:`, { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
}
