"use strict";

/**
 * ============================================================================
 * SERVICE CONTROL AT THE EDGE — the gateway relays, it never decides
 * ============================================================================
 *
 * Contract: `../../../docs/architecture/service-control.md`.
 *
 * The gateway owns no state (`test/security/gatewayIsStateless.test.js`): the
 * maintenance decision is taken by the backend and by Tx-Core. The edge has
 * exactly three duties, all pure and gathered here:
 *
 *   1. carry the app identity headers (`X-App-*`) to Tx-Core — the forwarded
 *      header set is REBUILT (`auditForwardHeaders`), so a header not listed
 *      here never reaches the engine, and a blocked app version could then
 *      never be refused;
 *   2. recognise a DELIBERATE refusal (`X-PayNoval-Service-Control`) so the
 *      circuit breaker does not count it as an outage. Without this, five
 *      maintenance 503s opened the breaker on the whole Tx-Core origin — which
 *      also carries the provider-webhook relay — for 30 s to 5 min, including
 *      after the reopening;
 *   3. relay an engine error WITHOUT losing its machine code. Until 2026-10-17
 *      `sendProxyError` rebuilt `{ message, error, details }` and dropped
 *      `code` — the limit codes (`LIMIT_*`) never reached the app either.
 *
 * Stripe's edge does the same: the API error object (`type`, `code`,
 * `message`, `param`) is what the client receives, verbatim.
 */

const SERVICE_CONTROL_HEADER = "x-paynoval-service-control";

const SERVICE_CONTROL_CODES = Object.freeze([
  "MAINTENANCE_ACTIVE",
  "FEATURE_UNAVAILABLE",
  "PROVIDER_UNAVAILABLE",
  "READ_ONLY_MODE",
  "SERVICE_LOCKDOWN",
  "SERVICE_STATUS_UNAVAILABLE",
  "UPDATE_REQUIRED",
]);

/**
 * Identity headers sent by the app. Each value is validated: a value that does
 * not match is DROPPED, never rewritten — an unknown version is "unknown"
 * (never blocked), whereas a forged one could otherwise be relayed as-is.
 */
const APP_IDENTITY_HEADERS = Object.freeze({
  "x-app-version": /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/,
  "x-app-platform": /^(ios|android|web)$/,
  "x-app-build": /^[0-9A-Za-z][0-9A-Za-z.-]{0,15}$/,
  "x-app-update-id": /^(embedded|[0-9A-Fa-f-]{8,64})$/,
  "x-app-runtime-version": /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/,
});

/** Keys never relayed from an engine error body (internal detail). */
const FORBIDDEN_ERROR_KEYS = Object.freeze(["stack", "trace", "debug", "internal", "cause"]);

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;

  const target = String(name).toLowerCase();

  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === target) return headers[key];
  }

  return undefined;
}

function pickAppIdentityHeaders(req) {
  const out = {};

  for (const [name, pattern] of Object.entries(APP_IDENTITY_HEADERS)) {
    const raw = headerValue(req?.headers, name);
    const value = String(Array.isArray(raw) ? raw[0] : raw ?? "").trim();
    const normalized = name === "x-app-platform" ? value.toLowerCase() : value;

    if (normalized && pattern.test(normalized)) out[name] = normalized;
  }

  return out;
}

/** `true` when the response is a refusal decided on purpose by the platform. */
function isDeliberateRefusal(response) {
  if (!response) return false;

  const code = String(headerValue(response.headers, SERVICE_CONTROL_HEADER) || "").trim();

  return SERVICE_CONTROL_CODES.includes(code);
}

function sanitizeErrorBody(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const body = { ...data };

  for (const key of FORBIDDEN_ERROR_KEYS) delete body[key];

  body.success = false;

  const message = body.message || body.error || null;

  if (message && typeof message === "string") {
    body.message = message;
    body.error = typeof body.error === "string" && body.error ? body.error : message;
  }

  return body;
}

/**
 * Builds the relayed error from an engine response, or `null` when there is
 * no usable JSON body (the caller then keeps its generic message).
 */
function relayEngineError(err) {
  const response = err?.response;
  if (!response) return null;

  const body = sanitizeErrorBody(response.data);
  if (!body) return null;

  const headers = {};
  const retryAfter = Number(headerValue(response.headers, "retry-after"));

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    headers["Retry-After"] = String(Math.ceil(retryAfter));
  }

  if (isDeliberateRefusal(response)) {
    headers["X-PayNoval-Service-Control"] = String(
      headerValue(response.headers, SERVICE_CONTROL_HEADER)
    ).trim();
    headers["Cache-Control"] = "no-store";
  }

  return {
    status: Number(response.status) || Number(err?.status) || 502,
    headers,
    body,
  };
}

module.exports = {
  SERVICE_CONTROL_HEADER,
  SERVICE_CONTROL_CODES,
  APP_IDENTITY_HEADERS,
  pickAppIdentityHeaders,
  isDeliberateRefusal,
  relayEngineError,
  sanitizeErrorBody,
};
