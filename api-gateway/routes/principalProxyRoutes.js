// File: api-gateway/routes/principalProxyRoutes.js
"use strict";

const { createProxyMiddleware, fixRequestBody } = require("http-proxy-middleware");
const config = require("../config");

const PRINCIPAL_URL = String(config?.principalUrl || process.env.PRINCIPAL_URL || "").replace(/\/+$/, "");
const INTERNAL_TOKEN = String(process.env.INTERNAL_TOKEN || config?.internalToken || "");

if (!PRINCIPAL_URL) {
  // On throw pas ici pour éviter crash au require en dev,
  // mais en prod c’est obligatoire.
  console.warn("[principalProxyRoutes] ⚠️ PRINCIPAL_URL manquant");
}

/**
 * ✅ Proxy fallback vers Backend Principal
 * - Forward toutes les routes /api/v1/* que le gateway n’a pas gérées avant
 * - Conserve Authorization: Bearer <jwt> => le backend principal valide le JWT
 * - Ajoute x-internal-token (si tu veux sécuriser la relation gateway -> principal)
 */
module.exports = createProxyMiddleware({
  target: PRINCIPAL_URL,
  changeOrigin: true,
  xfwd: true,
  proxyTimeout: 30000,
  timeout: 30000,

  // Important: on garde le chemin tel quel (gateway et principal ont /api/v1)
  // pathRewrite: (path) => path,  // pas nécessaire

  onProxyReq: (proxyReq, req, res) => {
    // ✅ si tu utilises express.json(), fixRequestBody évite body vide sur POST/PUT
    fixRequestBody(proxyReq, req);

    // ✅ token interne optionnel (recommandé si ton principal accepte x-internal-token)
    if (INTERNAL_TOKEN) proxyReq.setHeader("x-internal-token", INTERNAL_TOKEN);

    // ✅ audit/debug
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

  logLevel: process.env.NODE_ENV === "production" ? "warn" : "debug",
});
