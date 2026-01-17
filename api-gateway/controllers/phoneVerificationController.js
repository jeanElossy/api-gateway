"use strict";

const TrustedDepositNumber = require("../src/models/TrustedDepositNumber");
const logger = require("../src/logger");
const { startPhoneVerification, checkPhoneVerification } = require("../src/services/twilioVerify");

// Helpers
function getUserId(req) {
  return req.user?._id || req.user?.id || null;
}

function now() {
  return new Date();
}

function normalizePhoneToE164(rawPhone, country) {
  const p = String(rawPhone || "").trim().replace(/\s+/g, "");
  if (!p) return "";

  // déjà E.164
  if (p.startsWith("+")) return p;

  // fallback simple (tu peux l’améliorer après avec libphonenumber)
  // CI: +225
  const c = String(country || "").toUpperCase().trim();
  const digits = p.replace(/[^\d]/g, "");

  if (c === "CI") {
    // si l’utilisateur entre 0700000000 ou 700000000
    if (digits.length === 10) return `+225${digits}`;
    if (digits.length === 8) return `+2250${digits}`; // certains tapent 8 digits, on tente
  }

  // Si tu ne sais pas, impose E.164
  return "";
}

function isBlocked(doc) {
  if (!doc?.blockedUntil) return false;
  return doc.blockedUntil > now();
}

// Cooldown resend
const RESEND_COOLDOWN_SECONDS = 30; // comme Djamo (ex: 25s)
const MAX_SENDS_PER_WINDOW = 5;
const WINDOW_MINUTES = 15;

function canSendOtp(doc) {
  const t = now();

  // bloqué ?
  if (isBlocked(doc)) {
    return { ok: false, reason: "blocked" };
  }

  // cooldown
  if (doc?.lastSentAt) {
    const seconds = Math.floor((t.getTime() - new Date(doc.lastSentAt).getTime()) / 1000);
    if (seconds < RESEND_COOLDOWN_SECONDS) {
      return { ok: false, reason: "cooldown", retryIn: RESEND_COOLDOWN_SECONDS - seconds };
    }
  }

  // window rate
  // On fait simple: si doc.updatedAt dans la fenêtre, on limite sentCount
  // (Tu peux raffiner avec une collection “Attempts” plus tard)
  const updatedAt = doc?.updatedAt ? new Date(doc.updatedAt) : null;
  if (updatedAt) {
    const minutes = (t.getTime() - updatedAt.getTime()) / 60000;
    if (minutes <= WINDOW_MINUTES && (doc.sentCount || 0) >= MAX_SENDS_PER_WINDOW) {
      return { ok: false, reason: "rate_limit" };
    }
  }

  return { ok: true };
}

/**
 * POST /phone-verification/start
 * body: { phoneNumber, country, channel? }
 */
exports.start = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: "Non autorisé." });

    const { phoneNumber, country, channel } = req.body || {};
    const phoneE164 = normalizePhoneToE164(phoneNumber, country);

    if (!phoneE164) {
      return res.status(400).json({
        success: false,
        error: "Numéro invalide. Mets le numéro au format international (ex: +2250700000000).",
        code: "PHONE_INVALID",
      });
    }

    // upsert doc
    let doc = await TrustedDepositNumber.findOne({ userId, phoneE164 });

    if (!doc) {
      doc = await TrustedDepositNumber.create({
        userId,
        phoneE164,
        status: "pending",
        lastSentAt: null,
        sentCount: 0,
        blockedUntil: null,
        verifiedAt: null,
        createdAt: now(),
        updatedAt: now(),
      });
    }

    if (doc.status === "trusted") {
      return res.json({
        success: true,
        data: {
          phoneE164,
          status: "trusted",
          verifiedAt: doc.verifiedAt,
        },
        message: "Numéro déjà vérifié.",
      });
    }

    const okSend = canSendOtp(doc);
    if (!okSend.ok) {
      if (okSend.reason === "cooldown") {
        return res.status(429).json({
          success: false,
          error: `Veuillez patienter avant de renvoyer le code.`,
          code: "OTP_COOLDOWN",
          retryIn: okSend.retryIn,
        });
      }
      if (okSend.reason === "rate_limit") {
        // block 15 minutes
        const blockUntil = new Date(now().getTime() + 15 * 60 * 1000);
        await TrustedDepositNumber.updateOne(
          { _id: doc._id },
          { $set: { status: "blocked", blockedUntil: blockUntil, updatedAt: now() } }
        );
        return res.status(429).json({
          success: false,
          error: "Trop de tentatives. Réessayez plus tard.",
          code: "OTP_RATE_LIMIT",
          blockedUntil: blockUntil.toISOString(),
        });
      }
      if (okSend.reason === "blocked") {
        return res.status(429).json({
          success: false,
          error: "Vérification temporairement bloquée. Réessayez plus tard.",
          code: "OTP_BLOCKED",
          blockedUntil: doc.blockedUntil?.toISOString(),
        });
      }
    }

    // Twilio Verify
    await startPhoneVerification(phoneE164, channel || "sms");

    // update doc
    const t = now();
    const newCount = (doc.sentCount || 0) + 1;

    await TrustedDepositNumber.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: "pending",
          lastSentAt: t,
          sentCount: newCount,
          updatedAt: t,
        },
      }
    );

    return res.json({
      success: true,
      data: {
        phoneE164,
        status: "pending",
        resendIn: RESEND_COOLDOWN_SECONDS,
      },
      message: "Code envoyé par SMS.",
    });
  } catch (err) {
    logger?.error?.("[PhoneVerification] start error", { message: err?.message });
    return res.status(500).json({
      success: false,
      error: err?.message || "Erreur interne (start verification).",
    });
  }
};

/**
 * POST /phone-verification/verify
 * body: { phoneNumber, country, code }
 */
exports.verify = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: "Non autorisé." });

    const { phoneNumber, country, code } = req.body || {};
    const phoneE164 = normalizePhoneToE164(phoneNumber, country);

    if (!phoneE164) {
      return res.status(400).json({
        success: false,
        error: "Numéro invalide. Mets le numéro au format international (ex: +2250700000000).",
        code: "PHONE_INVALID",
      });
    }
    if (!code) {
      return res.status(400).json({ success: false, error: "Code requis.", code: "OTP_REQUIRED" });
    }

    const doc = await TrustedDepositNumber.findOne({ userId, phoneE164 });
    if (!doc) {
      return res.status(404).json({
        success: false,
        error: "Vérification introuvable. Lance d'abord l'envoi du code.",
        code: "OTP_NOT_STARTED",
      });
    }

    if (isBlocked(doc)) {
      return res.status(429).json({
        success: false,
        error: "Vérification bloquée temporairement. Réessayez plus tard.",
        code: "OTP_BLOCKED",
        blockedUntil: doc.blockedUntil?.toISOString(),
      });
    }

    const check = await checkPhoneVerification(phoneE164, String(code).trim());
    const status = String(check?.status || "").toLowerCase(); // approved / pending / canceled...

    if (status !== "approved") {
      return res.status(401).json({
        success: false,
        error: "Code invalide.",
        code: "OTP_INVALID",
        details: status,
      });
    }

    const t = now();
    await TrustedDepositNumber.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: "trusted",
          verifiedAt: t,
          blockedUntil: null,
          updatedAt: t,
        },
      }
    );

    return res.json({
      success: true,
      data: {
        phoneE164,
        status: "trusted",
        verifiedAt: t.toISOString(),
      },
      message: "Numéro vérifié.",
    });
  } catch (err) {
    logger?.error?.("[PhoneVerification] verify error", { message: err?.message });
    return res.status(500).json({
      success: false,
      error: err?.message || "Erreur interne (verify).",
    });
  }
};

/**
 * GET /phone-verification/list
 * Optionnel : liste des numéros trusted
 */
exports.list = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: "Non autorisé." });

    const list = await TrustedDepositNumber.find({ userId, status: "trusted" })
      .sort({ verifiedAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: (list || []).map((x) => ({
        phoneE164: x.phoneE164,
        verifiedAt: x.verifiedAt,
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Erreur interne." });
  }
};
