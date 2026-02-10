// routes/principalProxyRoutes.js
"use strict";

const { createProxyMiddleware, fixRequestBody } = require("http-proxy-middleware");
const config = require("../src/config"); // adapte si ton config est ailleurs

const PRINCIPAL_URL = String(
  config?.principalUrl || process.env.PRINCIPAL_URL || process.env.PRINCIPAL_API_BASE_URL || ""
).replace(/\/+$/, "");

const INTERNAL_TOKEN = String(process.env.INTERNAL_TOKEN || config?.internalToken || "");

if (!PRINCIPAL_URL) {
  console.warn("[principalProxyRoutes] ⚠️ PRINCIPAL_URL manquant");
}

module.exports = createProxyMiddleware({
  target: PRINCIPAL_URL,
  changeOrigin: true,
  xfwd: true,
  ws: true,
  proxyTimeout: 30000,
  timeout: 30000,
  logLevel: process.env.NODE_ENV === "production" ? "warn" : "debug",

  onProxyReq: (proxyReq, req) => {
    fixRequestBody(proxyReq, req);

    // Conserve JWT
    if (req.headers.authorization) {
      proxyReq.setHeader("Authorization", req.headers.authorization);
    }

    // Correlation id (si tu en utilises)
    if (req.headers["x-request-id"]) {
      proxyReq.setHeader("X-Request-Id", req.headers["x-request-id"]);
    }

    // Token interne optionnel (gateway -> principal)
    if (INTERNAL_TOKEN) proxyReq.setHeader("x-internal-token", INTERNAL_TOKEN);

    proxyReq.setHeader("x-forwarded-service", "api-gateway");
  },

  onError: (err, req, res) => {
    console.error("[principalProxyRoutes] proxy error:", err?.message || err);
    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        message: "Backend principal indisponible via gateway",
      });
    }
  },
});
