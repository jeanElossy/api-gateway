"use strict";

/**
 * ============================================================================
 * `/api/v1/transfer-claims` — RÉCLAMATION D'UN TRANSFERT (2026-11-04)
 * ============================================================================
 *
 * Le destinataire d'un transfert vers un portefeuille mobile money ou une
 * carte n'a pas de compte : il ouvre le lien reçu par SMS (page publique du
 * site), puis cette page appelle ces quatre routes. Tx-Core DÉCIDE de tout
 * (jeton haché, code SMS, réponse, essais, verrou) ; le bord :
 *
 *   - limite par ADRESSE IP (Tx-Core ne voit que la passerelle et limite, lui,
 *     par lien) ;
 *   - ne relaie qu'une liste FERMÉE de champs, bornés : jeton, réponse, code ;
 *   - ne journalise jamais le corps (le jeton vaut autorisation) ;
 *   - interdit toute mise en cache.
 */

const express = require("express");
const rateLimit = require("../src/middlewares/rateLimiter");
const { appelerTxCore } = require("../src/services/transactions/txCore");

const router = express.Router();

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^\d{6}$/;

const perIp = (name, max) =>
  rateLimit({
    name,
    windowMs: 10 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message: "Trop de tentatives. Réessayez dans quelques minutes." },
  });

router.use(express.json({ limit: "2kb" }));
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

/** Le corps relayé : jamais plus que ces champs, et bornés. */
function pickBody(req, fields) {
  const out = {};
  const token = String(req.body?.token || "");
  if (!TOKEN.test(token)) return null;
  out.token = token;
  if (fields.includes("code")) {
    const code = String(req.body?.code || "");
    if (!CODE.test(code)) return null;
    out.code = code;
  }
  if (fields.includes("answer")) {
    const answer = String(req.body?.answer || "");
    if (!answer.trim() || answer.length > 200) return null;
    out.answer = answer;
  }
  return out;
}

function relay(action, fields) {
  return async (req, res) => {
    const body = pickBody(req, fields);
    if (!body) {
      return res.status(400).json({ success: false, code: "INVALID_REQUEST", message: "Saisie incomplète ou invalide." });
    }

    try {
      const { status, body: out } = await appelerTxCore({
        req,
        method: "post",
        chemin: `/transfer-claims/${action}`,
        body,
      });
      return res.status(status).json(out);
    } catch (err) {
      const status = Number(err?.status) || 502;
      const data = err?.response?.data;
      // Refus métier (4xx) relayé tel quel ; panne (5xx) dite comme telle.
      return res.status(status).json(
        data && typeof data === "object"
          ? { success: false, code: data.code || null, message: data.message || data.error || "", attemptsLeft: data.attemptsLeft }
          : { success: false, code: err?.code || null, message: "Service momentanément indisponible." }
      );
    }
  };
}

router.post("/inspect", perIp("claim-inspect-ip", 60), relay("inspect", []));
router.post("/code", perIp("claim-code-ip", 10), relay("code", []));
router.post("/claim", perIp("claim-submit-ip", 20), relay("claim", ["code", "answer"]));
router.post("/refuse", perIp("claim-refuse-ip", 20), relay("refuse", ["code"]));

module.exports = router;
