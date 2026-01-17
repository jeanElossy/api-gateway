"use strict";

const TrustedDepositNumber = require("../src/models/TrustedDepositNumber");
const logger = require("../src/logger");
const { startPhoneVerification, checkPhoneVerification } = require("../src/services/twilioVerify");
const { toE164 } = require("../src/utils/phone");

// Helpers
function getUserId(req) {
  return req.user?._id || req.user?.id || null;
}

function now() {
  return new Date();
}

function isBlocked(doc) {
  if (!doc?.blockedUntil) return false;
  return new Date(doc.blockedUntil).getTime() > Date.now();
}

// Cooldown resend
const RESEND_COOLDOWN_SECONDS = 30; // ex: 30s
const MAX_SENDS_PER_WINDOW = 5;
const WINDOW_MINUTES = 15;

function canSendOtp(doc) {
  const t = now();

  if (isBlocked(doc)) return { ok: false, reason: "blocked" };

  // cooldown
  if (doc?.lastSentAt) {
    const seconds = Math.floor((t.getTime() - new Date(doc.lastSentAt).getTime()) / 1000);
    if (seconds < RESEND_COOLDOWN_SECONDS) {
      return { ok: false, reason: "cooldown", retryIn: RESEND_COOLDOWN_SECONDS - seconds };
    }
  }

  // window rate (simple)
  const updatedAt = doc?.updatedAt ? new Date(doc.updatedAt) : null;
  if (updatedAt) {
    const minutes = (t.getTime() - updatedAt.getTime()) / 60000;
    if (minutes <= WINDOW_MINUTES && (doc.sentCount || 0) >= MAX_SENDS_PER_WINDOW) {
      return { ok: false, reason: "rate_limit" };
    }
  }

  return { ok: true };
}

function normalizePhoneInput(reqBody) {
  const b = reqBody || {};
  const phone = b.phoneNumber || b.phone || b.to || "";
  const country = b.country || "";
  const channel = b.channel || "sms";
  return { phone, country, channel };
}

/**
 * POST /api/v1/phone-verification/start
 * body: { phoneNumber|phone, country, channel? }
 */
exports.start = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: "Non autorisé." });

    const { phone, country, channel } = normalizePhoneInput(req.body);
    const norm = toE164(phone, country);
    const phoneE164 = norm.e164;

    if (!phoneE164) {
      return res.status(400).json({
        success: false,
        error: "Numéro invalide. Mets le numéro au format international (ex: +2250700000000) ou un numéro local + country.",
        code: "PHONE_INVALID",
      });
    }

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
      });
    }

    if (doc.status === "trusted") {
      return res.json({
        success: true,
        data: { phoneE164, status: "trusted", verifiedAt: doc.verifiedAt },
        message: "Numéro déjà vérifié.",
      });
    }

    const okSend = canSendOtp(doc);
    if (!okSend.ok) {
      if (okSend.reason === "cooldown") {
        return res.status(429).json({
          success: false,
          error: "Veuillez patienter avant de renvoyer le code.",
          code: "OTP_COOLDOWN",
          retryIn: okSend.retryIn,
        });
      }

      if (okSend.reason === "rate_limit") {
        const blockUntil = new Date(Date.now() + 15 * 60 * 1000);
        await TrustedDepositNumber.updateOne(
          { _id: doc._id },
          { $set: { status: "blocked", blockedUntil: blockUntil } }
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

    // ✅ Twilio Verify: envoi OTP
    await startPhoneVerification(phoneE164, channel || "sms");

    // update doc
    const t = now();
    await TrustedDepositNumber.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: "pending",
          lastSentAt: t,
        },
        $inc: { sentCount: 1 },
      }
    );

    return res.json({
      success: true,
      data: {
        phoneE164,
        status: "pending",
        resendIn: RESEND_COOLDOWN_SECONDS,
      },
      message: "Code envoyé.",
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
 * POST /api/v1/phone-verification/verify
 * body: { phoneNumber|phone, country, code }
 */
exports.verify = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: "Non autorisé." });

    const { phone, country } = normalizePhoneInput(req.body);
    const code = String(req.body?.code || "").trim();

    const phoneE164 = toE164(phone, country).e164;

    if (!phoneE164) {
      return res.status(400).json({
        success: false,
        error: "Numéro invalide. Mets le numéro au format international (ex: +2250700000000) ou un numéro local + country.",
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

    const check = await checkPhoneVerification(phoneE164, code);
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
        },
      }
    );

    return res.json({
      success: true,
      data: { phoneE164, status: "trusted", verifiedAt: t.toISOString() },
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
 * GET /api/v1/phone-verification/list
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
