// File: api-gateway/routes/publicRoutes.js
"use strict";

const express = require("express");
const router = express.Router();
const axios = require("axios");

const config = require("../src/config");

// Controllers existants
const feesCtrl = require("../controllers/feesController");
const exchangeRatesCtrl = require("../controllers/exchangeRatesController");
const pricingCtrl = require("../controllers/pricingController");

/**
 * Public read-only endpoints (HMAC signed) mounted at:
 *   app.use("/api/v1/public", publicRoutes)
 *
 * ⚠️ IMPORTANT:
 * - La signature HMAC est vérifiée dans app.js avant ces routes.
 * - Ici: read-only uniquement.
 */

// -----------------------------------------------------------------------------
// 1) Fees simulate (READ-ONLY)
// GET /api/v1/public/fees/simulate
// -----------------------------------------------------------------------------
router.get("/fees/simulate", feesCtrl.simulateFee);

// -----------------------------------------------------------------------------
// 2) FX rate public (READ-ONLY)
// GET /api/v1/public/exchange-rates/rate?from&to
// -----------------------------------------------------------------------------
router.get("/exchange-rates/rate", exchangeRatesCtrl.getRatePublic);

// -----------------------------------------------------------------------------
// 3) Pricing quote (READ-ONLY)
// GET|POST /api/v1/public/pricing/quote
// -----------------------------------------------------------------------------
router.get("/pricing/quote", pricingCtrl.quote);
router.post("/pricing/quote", pricingCtrl.quote);
router.get("/pricing/preview", pricingCtrl.quote);
router.post("/pricing/preview", pricingCtrl.quote);

// Safety net: block anything that could be write
router.all("/pricing/lock", (_req, res) =>
  res.status(403).json({ success: false, message: "Forbidden on public endpoint" })
);

// -----------------------------------------------------------------------------
// 4) FX latest/history (READ-ONLY) - utile pour ton app (courbes)
// GET /api/v1/public/fx/latest?base&quote (ou from/to)
// GET /api/v1/public/fx/history?base&quote&days
//
// 👉 Ces endpoints appellent les endpoints internes du Gateway (/api/v1/fx/latest|history)
// Si chez toi le FX est dans un autre service, mets FX_SERVICE_URL.
// -----------------------------------------------------------------------------

const FX_SERVICE_URL =
  config.services?.fxBaseUrl ||
  process.env.FX_SERVICE_URL ||
  ""; // optionnel

async function proxyReadOnly(req, res, targetUrl) {
  try {
    const r = await axios.get(targetUrl, {
      params: req.query,
      timeout: 12000,
      headers: {
        Accept: "application/json",
        "X-Request-Id": req.headers["x-request-id"] || undefined,
      },
    });
    return res.status(r.status).json(r.data);
  } catch (e) {
    const status = e.response?.status || 502;
    const data = e.response?.data;
    return res.status(status).json({
      success: false,
      message: data?.message || data?.error || e.message || "Upstream error",
      upstreamStatus: e.response?.status,
    });
  }
}

router.get("/fx/latest", async (req, res) => {
  const base =
    String(req.query.base || req.query.from || "").toUpperCase().trim();
  const quote =
    String(req.query.quote || req.query.to || "").toUpperCase().trim();

  // Si FX_SERVICE_URL est défini, on le préfère
  if (FX_SERVICE_URL) {
    const url = FX_SERVICE_URL.replace(/\/+$/, "") + "/api/v1/fx/latest";
    return proxyReadOnly(req, res, url);
  }

  // Sinon, on appelle le gateway lui-même (même host) via l'URL interne
  // ⚠️ Render: utiliser l'host courant
  const selfBase = `${req.protocol}://${req.get("host")}`;
  const url = selfBase + "/api/v1/fx/latest";
  return proxyReadOnly(req, res, url);
});

router.get("/fx/history", async (req, res) => {
  if (FX_SERVICE_URL) {
    const url = FX_SERVICE_URL.replace(/\/+$/, "") + "/api/v1/fx/history";
    return proxyReadOnly(req, res, url);
  }

  const selfBase = `${req.protocol}://${req.get("host")}`;
  const url = selfBase + "/api/v1/fx/history";
  return proxyReadOnly(req, res, url);
});

// -----------------------------------------------------------------------------
// 5) Announcements en public signé (optionnel)
// GET /api/v1/public/announcements
// -----------------------------------------------------------------------------
router.get("/announcements", async (req, res) => {
  const ANN_URL =
    config.services?.principalBaseUrl ||
    process.env.PRINCIPAL_API_BASE_URL ||
    "";

  if (!ANN_URL) {
    return res.status(503).json({
      success: false,
      message: "Missing principal base url (PRINCIPAL_API_BASE_URL)",
    });
  }

  const url = ANN_URL.replace(/\/+$/, "") + "/api/v1/announcements";
  return proxyReadOnly(req, res, url);
});

module.exports = router;
