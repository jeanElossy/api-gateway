"use strict";

/**
 * ============================================================================
 * PAGE 3-D SECURE DE TEST — RENDU PUR (2026-10-06)
 * ============================================================================
 *
 * L'équivalent de la page « Complete / Fail authentication » des cartes de
 * test Stripe : le titulaire fictif approuve ou refuse, et le navigateur
 * intégré revient à l'application. Servie UNIQUEMENT pour des transactions de
 * simulation (Tx-Core ne délivre un jeton qu'à l'adapter carte sandbox).
 *
 * Fonctions PURES : aucune requête, aucun état. La route les compose.
 *
 * ⚠️ AUCUNE MENTION « SIMULATION » À L'ÉCRAN (décision du 2026-10-07) : la
 * page est filmée pour montrer le parcours tel qu'un client le vivra. Elle
 * n'est atteignable qu'avec un jeton émis pour une transaction sandbox ;
 * c'est le serveur, pas l'affichage, qui garantit qu'aucun argent ne bouge.
 *
 * Sécurité :
 *  - toute donnée affichée est échappée ;
 *  - aucune ressource externe, aucun script : la page fonctionne par un
 *    simple formulaire (CSP `default-src 'none'`) ;
 *  - le retour vers l'application n'accepte QUE les schémas de PayNoval
 *    (`paynoval://`, et ceux d'Expo en développement) : jamais un redirecteur
 *    ouvert vers un site web.
 */

const RETURN_URL = /^(paynoval|exp\+paynoval|exp):\/\/[^\s"'<>\\]{0,400}$/i;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** URL de retour acceptée, ou `null`. */
function safeReturnUrl(raw) {
  const url = String(raw ?? "").trim();
  return RETURN_URL.test(url) ? url : null;
}

/** Retour vers l'app, avec l'issue en indice (le serveur reste la vérité). */
function buildReturnTarget(returnUrl, decision) {
  const safe = safeReturnUrl(returnUrl);
  if (!safe) return null;
  const sep = safe.includes("?") ? "&" : "?";
  return `${safe}${sep}status=${encodeURIComponent(decision)}`;
}

function formatAmount(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  const decimals = ["XOF", "XAF", "JPY"].includes(String(currency).toUpperCase()) ? 0 : 2;
  return `${n.toLocaleString("fr-FR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} ${escapeHtml(currency || "")}`;
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' paynoval: exp+paynoval: exp:; " +
  "frame-ancestors 'none'; base-uri 'none'";

function layout(title, inner) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #f4f5f7; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #111317; color: #f1f1f1; } .card { background: #1c1f26 !important; } }
  .wrap { max-width: 420px; margin: 0 auto; padding: 24px 16px; }
  .card { background: #fff; border-radius: 14px; padding: 20px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 12px 0 4px; }
  .amount { font-size: 28px; font-weight: 700; margin: 12px 0; }
  .muted { opacity: .7; font-size: 14px; line-height: 1.4; }
  button { width: 100%; min-height: 48px; border: 0; border-radius: 10px; font-size: 16px; font-weight: 600; margin-top: 12px; cursor: pointer; }
  .ok { background: #0f766e; color: #fff; }
  .ko { background: transparent; color: inherit; border: 1px solid currentColor; }
</style>
</head>
<body><main class="wrap">${inner}</main></body>
</html>`;
}

function renderChallengePage({ token, challenge, returnUrl }) {
  const safeReturn = safeReturnUrl(returnUrl);
  const hidden = safeReturn
    ? `<input type="hidden" name="return_url" value="${escapeHtml(safeReturn)}">`
    : "";
  const action = `${encodeURIComponent(token)}`;

  return layout(
    "Authentification 3-D Secure",
    `<h1>Authentification 3-D Secure</h1>
<p class="muted">Confirmez ce paiement par carte.</p>
<section class="card">
  <div class="muted">Marchand : ${escapeHtml(challenge?.merchant || "PayNoval")}</div>
  <div class="amount">${formatAmount(challenge?.amount, challenge?.currency)}</div>
  <div class="muted">Référence : ${escapeHtml(challenge?.reference || "—")}</div>
  <form method="post" action="${action}">
    ${hidden}
    <button class="ok" type="submit" name="decision" value="approved">Valider l'authentification</button>
    <button class="ko" type="submit" name="decision" value="declined">Refuser l'authentification</button>
  </form>
</section>`
  );
}

function renderMessagePage({ title, message }) {
  return layout(
    title,
    `<h1>${escapeHtml(title)}</h1>
<section class="card"><p class="muted">${escapeHtml(message)}</p></section>`
  );
}

module.exports = {
  CSP,
  escapeHtml,
  safeReturnUrl,
  buildReturnTarget,
  renderChallengePage,
  renderMessagePage,
};
