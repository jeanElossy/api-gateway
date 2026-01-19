// middlewares/aml.js
"use strict";

const logger = require("../logger");
const {
  logTransaction,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  getMLScore,
  getBusinessKYBStatus,
} = require("../services/aml");
const blacklist = require("../aml/blacklist.json");
const { sendFraudAlert } = require("../utils/alert");
const { getCurrencySymbolByCode, getCurrencyCodeByCountry } = require("../tools/currency");
const { getDailyLimit, getSingleTxLimit } = require("../tools/amlLimits");

const RISKY_COUNTRIES_ISO = new Set(["IR", "KP", "SD", "SY", "CU", "RU", "AF", "SO", "YE", "VE", "LY"]);

// Stripe: on compare sur code ISO plutôt que symbole
const ALLOWED_STRIPE_CURRENCY_CODES = ["EUR", "USD", "CAD"];

// --------------------------
// utils
// --------------------------
function maskSensitive(obj) {
  const SENSITIVE_FIELDS = ["password", "cardNumber", "iban", "cvc", "securityCode", "otp", "code", "pin"];
  if (!obj || typeof obj !== "object") return obj;

  const out = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    if (SENSITIVE_FIELDS.includes(k)) {
      out[k] = "***";
    } else if (obj[k] && typeof obj[k] === "object") {
      out[k] = maskSensitive(obj[k]);
    } else {
      out[k] = obj[k];
    }
  }
  return out;
}

// ✅ parse amount robuste
function parseAmount(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/\s/g, "").replace(",", ".").trim();
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// ✅ normalize country input: "france" -> "FR", "cote d'ivoire" -> "CI", "FR" -> "FR"
function normalizeCountryToISO(country) {
  if (!country) return "";
  const raw = String(country).trim();
  if (!raw) return "";

  // déjà ISO2
  if (/^[A-Z]{2}$/.test(raw.toUpperCase())) return raw.toUpperCase();

  const n = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  const map = {
    france: "FR",
    "cote d'ivoire": "CI",
    "cote divoire": "CI",
    "ivory coast": "CI",
    "burkina faso": "BF",
    mali: "ML",
    senegal: "SN",
    cameroun: "CM",
    cameroon: "CM",
    belgique: "BE",
    allemagne: "DE",
    germany: "DE",
    usa: "US",
    "etats-unis": "US",
    "etats unis": "US",
    "united states": "US",
    canada: "CA",
    uk: "GB",
    "royaume-uni": "GB",
    "royaume uni": "GB",
    "united kingdom": "GB",
    russie: "RU",
    russia: "RU",
  };

  return map[n] || "";
}

// ✅ provider resolver (plus stable)
function resolveProvider(req) {
  const rp = String(req.routedProvider || "").trim().toLowerCase();
  if (rp) return rp;

  const b = req.body || {};
  const p =
    String(b.provider || "").trim().toLowerCase() ||
    String(b.destination || "").trim().toLowerCase() ||
    String(b.funds || "").trim().toLowerCase();

  return p || "paynoval";
}

// ✅ normalize currency ISO (accepte symboles et variantes)
function normalizeCurrencyISO(v) {
  const s0 = String(v || "").trim().toUpperCase();
  if (!s0) return "";

  const s = s0.replace(/\u00A0/g, " ");

  // CFA
  if (s === "FCFA" || s === "CFA" || s === "F CFA" || s.includes("CFA")) return "XOF";

  // symboles
  if (s === "€") return "EUR";
  if (s === "$") return "USD";
  if (s === "£") return "GBP";

  // $CAD / CAD$ / $USD / USD$ / US$
  const letters = s.replace(/[^A-Z]/g, "");
  if (letters === "CAD") return "CAD";
  if (letters === "USD") return "USD";
  if (letters === "EUR") return "EUR";
  if (letters === "GBP") return "GBP";
  if (letters === "XOF") return "XOF";
  if (letters === "XAF") return "XAF";

  if (/^[A-Z]{3}$/.test(letters)) return letters;
  if (/^[A-Z]{3}$/.test(s)) return s;

  return "";
}

// ✅ currency resolver: priorité ISO source -> currencyCode -> currency -> selectedCurrency -> country
function resolveCurrencyCode(req) {
  const b = req.body || {};

  // priorité aux nouveaux champs ISO
  const candidate =
    b.currencySource ||
    b.currencyCode ||
    b.senderCurrencyCode ||
    b.currencySender ||
    b.currency ||
    b.selectedCurrency ||
    // au cas où tu passes currencyTarget par erreur
    b.currencyTarget ||
    "";

  let iso = normalizeCurrencyISO(candidate);

  // fallback: pays
  if (!iso) {
    const country = b.country || req.user?.country || req.user?.selectedCountry || "";
    iso = normalizeCurrencyISO(getCurrencyCodeByCountry(country)) || "USD";
  }

  if (!/^[A-Z]{3}$/.test(iso)) iso = "USD";
  return iso;
}

module.exports = async function amlMiddleware(req, res, next) {
  const provider = resolveProvider(req);
  const user = req.user;

  const body = req.body || {};
  const toEmail = body.toEmail || body.email || body.recipientEmail || "";
  const iban = body.iban || body.toIBAN || "";
  const phoneNumber = body.phoneNumber || body.toPhone || body.phone || "";

  const countryRaw = body.country || user?.country || user?.selectedCountry || "";
  const countryISO = normalizeCountryToISO(countryRaw);

  // priorité amountSource puis amount
  const amount = parseAmount(body.amountSource ?? body.amount);

  // ✅ ISO (XOF/EUR/USD/CAD...)
  const currencyCode = resolveCurrencyCode(req);
  const currencySymbol = getCurrencySymbolByCode(currencyCode); // affichage seulement

  try {
    // Auth
    if (!user || !user._id) {
      logger.warn("[AML] User manquant", { provider });
      await logTransaction({
        userId: null,
        type: "initiate",
        provider,
        amount,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "User manquant",
      });
      return res.status(401).json({ success: false, error: "Merci de vous connecter pour poursuivre.", code: "AUTH_REQUIRED" });
    }

    // KYC/KYB checks
    if (user.type === "business" || user.isBusiness) {
      let kybStatus = user.kybStatus;
      if (typeof getBusinessKYBStatus === "function") {
        kybStatus = await getBusinessKYBStatus(user.businessId || user._id);
      }
      if (!kybStatus || kybStatus !== "validé") {
        logger.warn("[AML] KYB insuffisant", { provider, user: user.email });
        await logTransaction({
          userId: user._id,
          type: "initiate",
          provider,
          amount,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: "KYB insuffisant",
        });
        await sendFraudAlert({ user, type: "kyb_insuffisant", provider });
        return res.status(403).json({
          success: false,
          error:
            "L’accès aux transactions est temporairement restreint. Merci de compléter la vérification d’entreprise en soumettant vos documents. Vous recevrez une notification dès l’activation de votre compte entreprise.",
          code: "KYB_REQUIRED",
        });
      }
    } else {
      if (!user.kycLevel || user.kycLevel < 2) {
        logger.warn("[AML] KYC insuffisant", { provider, user: user.email });
        await logTransaction({
          userId: user._id,
          type: "initiate",
          provider,
          amount,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: "KYC insuffisant",
        });
        await sendFraudAlert({ user, type: "kyc_insuffisant", provider });
        return res.status(403).json({
          success: false,
          error: "Votre vérification d’identité (KYC) n’est pas finalisée. Merci de compléter votre profil pour accéder aux transactions.",
          code: "KYC_REQUIRED",
        });
      }
    }

    // PEP/Sanction
    const pepStatus = await getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber });
    if (pepStatus && pepStatus.sanctioned) {
      logger.error("[AML] PEP/Sanction detected", { user: user.email, reason: pepStatus.reason });
      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: pepStatus.reason,
      });
      await sendFraudAlert({ user, type: "pep_sanction", provider, reason: pepStatus.reason });
      return res.status(403).json({
        success: false,
        error: "Impossible d’effectuer la transaction : le bénéficiaire est sur liste de surveillance.",
        code: "PEP_SANCTIONED",
      });
    }

    // Blacklist
    if (
      (toEmail && Array.isArray(blacklist.emails) && blacklist.emails.includes(toEmail)) ||
      (iban && Array.isArray(blacklist.ibans) && blacklist.ibans.includes(iban)) ||
      (phoneNumber && Array.isArray(blacklist.phones) && blacklist.phones.includes(phoneNumber))
    ) {
      logger.warn("[AML] Transaction vers cible blacklistée", { provider, toEmail, iban, phoneNumber });
      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Blacklist",
      });
      await sendFraudAlert({ user, type: "blacklist", provider, toEmail, iban, phoneNumber });
      return res.status(403).json({
        success: false,
        error: "Transaction interdite : destinataire soumis à une restriction de conformité (AML).",
        code: "BLACKLISTED",
      });
    }

    // Pays à risque (ISO2)
    if (countryISO && RISKY_COUNTRIES_ISO.has(countryISO)) {
      logger.warn("[AML] Pays à risque/sanctionné détecté", { provider, user: user.email, countryRaw, countryISO });
      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Pays à risque",
      });
      await sendFraudAlert({ user, type: "pays_risque", provider, country: countryISO });
      return res.status(403).json({
        success: false,
        error: "Transaction bloquée : pays de destination non autorisé.",
        code: "RISKY_COUNTRY",
        details: { country: countryISO },
      });
    }

    // --- LIMITES PAR ENVOI ET PAR JOUR ---
    // ✅ IMPORTANT: on passe la devise ISO (pas le symbole)
    const singleTxLimit = getSingleTxLimit(provider, currencyCode);

    if (amount > singleTxLimit) {
      logger.warn("[AML] Plafond par transaction dépassé", {
        provider,
        user: user.email,
        tryAmount: amount,
        max: singleTxLimit,
        currencyCode,
        currencySymbol,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: `Plafond par transaction dépassé (${amount} > ${singleTxLimit} ${currencyCode})`,
      });

      return res.status(403).json({
        success: false,
        error: `Le plafond autorisé par transaction est de ${singleTxLimit} ${currencySymbol} pour ce moyen de paiement. Merci de réduire le montant ou de contacter le support.`,
        code: "AML_SINGLE_LIMIT",
        details: { max: singleTxLimit, currencyCode, currencySymbol, provider },
      });
    }

    const dailyLimit = getDailyLimit(provider, currencyCode);

    // ✅ stats: on passe ISO (et fallback au symbole si ton service attend symbole)
    let stats = null;
    try {
      stats = await getUserTransactionsStats(user._id, provider, currencyCode);
      // si ton service existant attend symbole, on fallback
      if (!stats || typeof stats !== "object") {
        stats = await getUserTransactionsStats(user._id, provider, currencySymbol);
      }
    } catch {
      // ignore, stats restera null
    }

    const dailyTotal = stats && Number.isFinite(stats.dailyTotal) ? stats.dailyTotal : 0;
    const futureTotal = dailyTotal + (amount || 0);

    if (futureTotal > dailyLimit) {
      logger.warn("[AML] Plafond journalier dépassé", {
        provider,
        user: user.email,
        dailyTotal,
        tryAmount: amount,
        max: dailyLimit,
        currencyCode,
        currencySymbol,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: `Plafond journalier dépassé (${dailyTotal} + ${amount} > ${dailyLimit} ${currencyCode})`,
      });

      return res.status(403).json({
        success: false,
        error: `Le plafond journalier autorisé est atteint (${dailyLimit} ${currencySymbol}). Vous ne pouvez plus effectuer de nouvelles transactions aujourd'hui avec ce moyen de paiement. Réessayez demain ou contactez le support.`,
        code: "AML_DAILY_LIMIT",
        details: { max: dailyLimit, currencyCode, currencySymbol, provider, dailyTotal },
      });
    }

    // Challenge AML (montant proche du plafond)
    const userQuestions = user.securityQuestions || [];
    const needAmlChallenge = typeof amount === "number" && amount >= dailyLimit * 0.9 && userQuestions.length > 0;

    if (needAmlChallenge) {
      if (!body.securityQuestion || !body.securityAnswer) {
        const qIdx = Math.floor(Math.random() * userQuestions.length);
        return res.status(428).json({
          success: false,
          error: "AML_SECURITY_CHALLENGE",
          code: "AML_SECURITY_CHALLENGE",
          need_security_answer: true,
          securityQuestion: userQuestions[qIdx].question,
        });
      }

      const idx = userQuestions.findIndex((q) => q.question === body.securityQuestion);
      if (idx === -1) {
        return res.status(403).json({ success: false, error: "Question AML inconnue.", code: "AML_QUESTION_UNKNOWN" });
      }

      const ok =
        String(userQuestions[idx].answer || "").trim().toLowerCase() ===
        String(body.securityAnswer || "").trim().toLowerCase();

      if (!ok) {
        logger.warn("[AML] Réponse AML incorrecte", { user: user.email });
        await logTransaction({
          userId: user._id,
          type: "initiate",
          provider,
          amount,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: "AML Sécurité question échouée",
        });
        await sendFraudAlert({ user, type: "aml_security_failed", provider });

        return res.status(403).json({
          success: false,
          error: "Réponse à la question de sécurité incorrecte.",
          code: "AML_SECURITY_FAILED",
        });
      }
    }

    // Limites de pattern (structuring, volume horaire, etc)
    if (stats && stats.lastHour > 10) {
      logger.warn("[AML] Volume suspect sur 1h", { provider, user: user.email, lastHour: stats.lastHour });
      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Volume élevé 1h",
      });
      await sendFraudAlert({ user, type: "volume_1h", provider, count: stats.lastHour });

      return res.status(403).json({
        success: false,
        error: "Trop de transactions sur 1h, vérification requise.",
        code: "AML_RATE_LIMIT_1H",
        details: { count: stats.lastHour },
      });
    }

    if (stats && stats.sameDestShortTime > 3) {
      logger.warn("[AML] Pattern structuring suspect", {
        provider,
        user: user.email,
        sameDestShortTime: stats.sameDestShortTime,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Pattern structuring",
      });

      await sendFraudAlert({ user, type: "structuring", provider, count: stats.sameDestShortTime });

      return res.status(403).json({
        success: false,
        error: "Activité inhabituelle détectée. Une vérification supplémentaire est requise.",
        code: "AML_STRUCTURING",
        details: { count: stats.sameDestShortTime },
      });
    }

    // Stripe: devise autorisée (ISO)
    if (provider === "stripe" && currencyCode && !ALLOWED_STRIPE_CURRENCY_CODES.includes(currencyCode)) {
      logger.warn("[AML] Devise non autorisée pour Stripe", { user: user.email, currencyCode });
      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Devise interdite Stripe",
      });
      await sendFraudAlert({ user, type: "devise_interdite", provider, currencyCode });

      return res.status(403).json({
        success: false,
        error: "Devise non autorisée.",
        code: "STRIPE_CURRENCY_NOT_ALLOWED",
        details: { currencyCode, currencySymbol },
      });
    }

    // ML scoring (optionnel)
    if (typeof getMLScore === "function") {
      const score = await getMLScore(body, user);
      if (score && score >= 0.9) {
        logger.warn("[AML] ML scoring élevé", { user: user.email, score });
        await logTransaction({
          userId: user._id,
          type: "initiate",
          provider,
          amount,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: "Scoring ML élevé",
        });
        await sendFraudAlert({ user, type: "ml_suspect", provider, score });

        return res.status(403).json({
          success: false,
          error:
            "Votre transaction est temporairement bloquée pour vérification supplémentaire (sécurité renforcée). Notre équipe analyse automatiquement les transactions suspectes. Merci de réessayer plus tard ou contactez le support si besoin.",
          code: "AML_ML_BLOCK",
          details: { score },
        });
      }
    }

    // Log OK
    await logTransaction({
      userId: user._id,
      type: "initiate",
      provider,
      amount,
      toEmail,
      details: maskSensitive(body),
      flagged: false,
      flagReason: "",
    });

    logger.info("[AML] AML OK", {
      provider,
      user: user.email,
      amount,
      currencyCode,
      toEmail,
      iban,
      phoneNumber,
      countryRaw,
      countryISO,
      stats,
    });

    next();
  } catch (e) {
    logger.error("[AML] Exception", { err: e?.message || e, user: user?.email });
    try {
      await logTransaction({
        userId: user?._id,
        type: "initiate",
        provider,
        amount,
        toEmail,
        details: maskSensitive({ ...body, error: e?.message }),
        flagged: true,
        flagReason: "Erreur système AML",
      });
    } catch {}
    return res.status(500).json({ success: false, error: "Erreur système AML", code: "AML_SYSTEM_ERROR" });
  }
};
