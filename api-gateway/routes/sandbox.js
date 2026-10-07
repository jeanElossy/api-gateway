"use strict";

/**
 * ============================================================================
 * `/api/v1/sandbox` — MODE SIMULATION (2026-10-06)
 * ============================================================================
 *
 * Deux surfaces, toutes deux relayées à Tx-Core qui DÉCIDE (le bord n'a aucune
 * règle métier ici) :
 *
 *  1. `/3ds/:token` — PUBLIQUE. La page d'authentification de test ouverte
 *     dans le navigateur intégré de l'app, qui n'a pas le JWT. Le jeton à
 *     usage unique de l'URL est l'autorisation ; Tx-Core le vérifie (haché,
 *     15 min, une seule décision). La page est rendue ICI, Tx-Core ne rend que
 *     des données.
 *  2. `/state`, `/scenario`, `/faucet`, `/drain`, `/reset` — JWT. Tx-Core rend
 *     404 à un compte réel : ces outils n'existent pas pour lui.
 */

const express = require("express");

const rateLimit = require("../src/middlewares/rateLimiter");
const { protect } = require("../src/middlewares/auth");
const { appelerTxCore } = require("../src/services/transactions/txCore");
const { invalidateUserListCache } = require("../src/services/transactions/listCache");
const page = require("../src/services/sandbox/threeDSPage");

const router = express.Router();

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

function sendHtml(res, status, html) {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Content-Security-Policy", page.CSP);
  res.set("Cache-Control", "no-store");
  // Le jeton est dans l'URL : il ne doit fuiter vers aucun site tiers.
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  return res.status(status).send(html);
}

const threeDSLimiter = rateLimit({
  name: "sandbox-3ds",
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ── 1. Page 3-D Secure de test (publique) ─────────────────────────────── */

router.get("/3ds/:token", threeDSLimiter, async (req, res) => {
  const token = String(req.params.token || "");
  if (!TOKEN.test(token)) {
    return sendHtml(res, 404, page.renderMessagePage({
      title: "Lien invalide",
      message: "Ce lien d'authentification n'est pas valide.",
    }));
  }

  try {
    const { status, body } = await appelerTxCore({
      req,
      method: "get",
      chemin: `/sandbox/3ds/${encodeURIComponent(token)}`,
    });

    if (status < 200 || status >= 300 || !body?.data) {
      return sendHtml(res, 410, page.renderMessagePage({
        title: "Authentification expirée",
        message: "Cette authentification a expiré ou a déjà été traitée. Revenez à l'application.",
      }));
    }

    return sendHtml(res, 200, page.renderChallengePage({
      token,
      challenge: body.data,
      returnUrl: req.query?.return_url,
    }));
  } catch (err) {
    const status = Number(err?.status) || 503;
    return sendHtml(res, status === 404 || status === 410 ? 410 : 503, page.renderMessagePage({
      title: status === 404 || status === 410 ? "Authentification expirée" : "Service indisponible",
      message:
        status === 404 || status === 410
          ? "Cette authentification a expiré ou a déjà été traitée. Revenez à l'application."
          : "La page d'authentification est momentanément indisponible. Réessayez.",
    }));
  }
});

router.post("/3ds/:token", threeDSLimiter, async (req, res) => {
  const token = String(req.params.token || "");
  const decision = String(req.body?.decision || "").trim().toLowerCase();

  if (!TOKEN.test(token) || !["approved", "declined"].includes(decision)) {
    return sendHtml(res, 400, page.renderMessagePage({
      title: "Demande invalide",
      message: "Décision d'authentification invalide.",
    }));
  }

  try {
    const { status } = await appelerTxCore({
      req,
      method: "post",
      chemin: `/sandbox/3ds/${encodeURIComponent(token)}/decision`,
      body: { decision },
    });

    if (status < 200 || status >= 300) throw Object.assign(new Error("refus"), { status });
  } catch (err) {
    const gone = [404, 410].includes(Number(err?.status));
    return sendHtml(res, gone ? 410 : 503, page.renderMessagePage({
      title: gone ? "Authentification expirée" : "Service indisponible",
      message: gone
        ? "Cette authentification a expiré ou a déjà été traitée. Revenez à l'application."
        : "La décision n'a pas pu être enregistrée. Réessayez.",
    }));
  }

  // Retour à l'application : seulement vers un schéma PayNoval (jamais un site).
  const target = page.buildReturnTarget(req.body?.return_url, decision);
  if (target) return res.redirect(303, target);

  return sendHtml(res, 200, page.renderMessagePage({
    title: decision === "approved" ? "Authentification validée" : "Authentification refusée",
    message: "Vous pouvez revenir à l'application.",
  }));
});

/* ── 2. Outils du compte de simulation (JWT) ───────────────────────────── */

router.use(protect);

function relay({ method, chemin, invalidate = false }) {
  return async (req, res) => {
    try {
      const { status, body } = await appelerTxCore({
        req,
        method,
        chemin,
        body: method === "get" ? undefined : req.body,
      });

      // Recharger, vider ou réinitialiser change l'historique et le solde :
      // les pages de liste mises en cache pour ce compte deviennent fausses.
      if (invalidate && status >= 200 && status < 300) {
        invalidateUserListCache(req.user?._id || req.user?.id);
      }

      return res.status(status).json(body);
    } catch (err) {
      // Le statut et le corps de Tx-Core sont relayés VERBATIM : le client
      // doit distinguer « refusé » (4xx, code métier) de « indisponible » (5xx).
      const status = Number(err?.status) || 502;
      const data = err?.response?.data;
      return res.status(status).json(
        data && typeof data === "object"
          ? data
          : { success: false, error: "Outils de simulation indisponibles.", code: err?.code || null }
      );
    }
  };
}

router.get("/state", relay({ method: "get", chemin: "/sandbox/state" }));
router.put("/scenario", relay({ method: "put", chemin: "/sandbox/scenario" }));
router.post("/faucet", relay({ method: "post", chemin: "/sandbox/faucet", invalidate: true }));
router.post("/drain", relay({ method: "post", chemin: "/sandbox/drain", invalidate: true }));
router.post("/reset", relay({ method: "post", chemin: "/sandbox/reset", invalidate: true }));

module.exports = router;
