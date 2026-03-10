"use strict";

/**
 * --------------------------------------------------------------------------
 * Transaction response normalizers
 * --------------------------------------------------------------------------
 * Objectif :
 * - fournir à l'app un format argent/devises plus homogène
 * - masquer les champs sensibles
 * --------------------------------------------------------------------------
 */

function reqAny(paths) {
  for (const p of paths) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      return require(p);
    } catch {}
  }
  const e = new Error(`Module introuvable (paths tried): ${paths.join(", ")}`);
  e.status = 500;
  throw e;
}

const { normalizeCurrency } = reqAny([
  "../../src/utils/currency",
  "../../utils/currency",
]);

function nNum(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function normalizeCurrencyCode(v, countryHint = "") {
  const out = normalizeCurrency ? normalizeCurrency(v, countryHint) : "";
  return out ? String(out).toUpperCase() : null;
}

function toIdStr(v) {
  if (!v) return "";

  if (typeof v === "object") {
    const inner = v._id || v.id;
    if (inner) return String(inner);

    try {
      if (typeof v.toString === "function") {
        const s = String(v.toString());
        if (s && s !== "[object Object]") return s;
      }
    } catch {}
  }

  if (typeof v === "string") return v;
  return String(v);
}

function sameId(a, b) {
  const as = toIdStr(a);
  const bs = toIdStr(b);
  return !!as && !!bs && as === bs;
}

function computeDirectionForViewer(tx, viewerUserId) {
  const me = viewerUserId ? String(viewerUserId) : "";

  const owner =
    tx?.ownerUserId ||
    tx?.initiatorUserId ||
    tx?.createdBy ||
    tx?.userId ||
    tx?.sender ||
    tx?.meta?.ownerUserId ||
    tx?.meta?.initiatorUserId ||
    tx?.meta?.createdBy;

  const receiver =
    tx?.receiver ||
    tx?.receiverUserId ||
    tx?.toUserId ||
    tx?.meta?.receiver ||
    tx?.meta?.receiverUserId;

  if (me && receiver && sameId(receiver, me)) return "credit";
  if (me && owner && sameId(owner, me)) return "debit";
  if (me && tx?.userId && sameId(tx.userId, me)) return "debit";

  return "";
}

function buildMoneyView(tx = {}, viewerUserId = null) {
  const m = tx.meta || {};
  const r = m?.recipientInfo || {};

  const entry = String(m?.entry || "").toLowerCase();
  const countryHint0 = tx.country || m.country || r.country || "";

  if (entry === "participant.debit") {
    const ccy =
      normalizeCurrencyCode(m.walletCurrencyCode, countryHint0) ||
      normalizeCurrencyCode(tx.currency, countryHint0) ||
      normalizeCurrencyCode(m.payerCurrencyCode, countryHint0) ||
      normalizeCurrencyCode(m.baseCurrencyCode, countryHint0);

    const amt =
      nNum(m.amountDebitedWallet) ?? nNum(tx.amount) ?? nNum(m.amountPayer) ?? null;

    const money = {
      source: amt != null && ccy ? { amount: amt, currency: ccy } : null,
      feeSource: null,
      target: null,
      fxRateSourceToTarget: null,
    };

    return {
      money,
      viewerCurrencyCode: money.source?.currency || null,
      amountViewer: money.source?.amount ?? null,
      direction: "debit",
      countryHint: countryHint0,
    };
  }

  if (entry === "admin.fee.credit") {
    const ccy =
      normalizeCurrencyCode(m.adminCurrencyCode, countryHint0) ||
      normalizeCurrencyCode(tx.currency, countryHint0) ||
      "CAD";

    const amt = nNum(m.feeAmountAdmin) ?? nNum(tx.amount) ?? null;

    const money = {
      source: null,
      feeSource: null,
      target: amt != null && ccy ? { amount: amt, currency: ccy } : null,
      fxRateSourceToTarget: null,
    };

    return {
      money,
      viewerCurrencyCode: money.target?.currency || null,
      amountViewer: money.target?.amount ?? null,
      direction: "credit",
      countryHint: countryHint0,
    };
  }

  const countryHint = tx.country || m.country || r.country || "";

  const sourceCurrency =
    normalizeCurrencyCode(tx.currencySource, countryHint) ||
    normalizeCurrencyCode(m.currencySource, countryHint) ||
    normalizeCurrencyCode(m.selectedCurrency, countryHint) ||
    normalizeCurrencyCode(m.payerCurrencyCode, countryHint) ||
    normalizeCurrencyCode(m.baseCurrencyCode, countryHint) ||
    normalizeCurrencyCode(r.selectedCurrency, countryHint) ||
    normalizeCurrencyCode(r.currencySender, countryHint) ||
    normalizeCurrencyCode(r.senderCurrencySymbol, countryHint) ||
    normalizeCurrencyCode(m.senderCurrencySymbol, countryHint) ||
    normalizeCurrencyCode(tx.currency, countryHint);

  const targetCurrency =
    normalizeCurrencyCode(tx.currencyTarget, countryHint) ||
    normalizeCurrencyCode(m.currencyTarget, countryHint) ||
    normalizeCurrencyCode(m.localCurrencyCode, countryHint) ||
    normalizeCurrencyCode(r.localCurrencyCode, countryHint) ||
    normalizeCurrencyCode(m.localCurrencySymbol, countryHint) ||
    normalizeCurrencyCode(r.localCurrencySymbol, countryHint) ||
    sourceCurrency ||
    null;

  const amountSource =
    nNum(tx.amountSource) ??
    nNum(m.amountSource) ??
    nNum(m.amountPayer) ??
    nNum(r.amountPayer) ??
    nNum(m.amount) ??
    nNum(r.amount) ??
    nNum(tx.amount);

  const amountTarget =
    nNum(tx.amountTarget) ??
    nNum(m.amountTarget) ??
    nNum(m.localAmount) ??
    nNum(r.localAmount) ??
    nNum(m.amountCreator) ??
    nNum(r.amountCreator) ??
    nNum(tx.netAmount) ??
    amountSource ??
    null;

  const feeSource =
    nNum(tx.feeSource) ??
    nNum(m.feeSource) ??
    nNum(m.transactionFees) ??
    nNum(r.transactionFees) ??
    nNum(m.feeAmount) ??
    nNum(tx.fees) ??
    null;

  const fx =
    nNum(tx.fxRateSourceToTarget) ??
    nNum(m.fxRateSourceToTarget) ??
    nNum(m.exchangeRate) ??
    nNum(r.exchangeRate) ??
    nNum(m.fxPayerToCreator) ??
    nNum(m?.fxBaseToAdmin?.rate) ??
    null;

  const money = {
    source:
      amountSource != null && sourceCurrency
        ? { amount: amountSource, currency: sourceCurrency }
        : null,
    feeSource:
      feeSource != null && sourceCurrency
        ? { amount: feeSource, currency: sourceCurrency }
        : null,
    target:
      amountTarget != null && targetCurrency
        ? { amount: amountTarget, currency: targetCurrency }
        : null,
    fxRateSourceToTarget: fx != null ? fx : null,
  };

  const direction = computeDirectionForViewer(tx, viewerUserId);

  const viewerAtom =
    direction === "credit"
      ? money.target
      : direction === "debit"
      ? money.source
      : money.source || money.target || null;

  const viewerCurrencyCode =
    viewerAtom?.currency || money.source?.currency || money.target?.currency || null;
  const amountViewer = viewerAtom?.amount ?? null;

  return { money, viewerCurrencyCode, amountViewer, direction, countryHint };
}

function normalizeTxForResponse(tx, viewerUserId = null) {
  if (!tx || typeof tx !== "object") return tx;

  const out = { ...tx };
  out.id = out.id || (out._id ? String(out._id) : undefined);

  const { money, viewerCurrencyCode, amountViewer, direction, countryHint } =
    buildMoneyView(out, viewerUserId);

  const isoLegacy = normalizeCurrencyCode(out.currency, countryHint);
  if (isoLegacy) out.currency = isoLegacy;

  out.currencySource =
    normalizeCurrencyCode(out.currencySource, countryHint) ||
    money.source?.currency ||
    null;

  out.amountSource =
    out.amountSource != null ? nNum(out.amountSource) : money.source?.amount ?? null;

  out.feeSource =
    out.feeSource != null ? nNum(out.feeSource) : money.feeSource?.amount ?? null;

  out.currencyTarget =
    normalizeCurrencyCode(out.currencyTarget, countryHint) ||
    money.target?.currency ||
    null;

  out.amountTarget =
    out.amountTarget != null ? nNum(out.amountTarget) : money.target?.amount ?? null;

  out.fxRateSourceToTarget =
    out.fxRateSourceToTarget != null
      ? nNum(out.fxRateSourceToTarget)
      : money.fxRateSourceToTarget ?? null;

  out.money = {
    source: money.source,
    feeSource: money.feeSource,
    target: money.target,
    fxRateSourceToTarget: money.fxRateSourceToTarget,
  };

  out.viewerCurrencyCode = viewerCurrencyCode;
  out.amountViewer = amountViewer;
  out.directionForViewer = direction;

  out.meta = { ...(out.meta || {}) };
  if (viewerCurrencyCode) out.meta.viewerCurrencyCode = viewerCurrencyCode;
  if (amountViewer != null) out.meta.amountViewer = amountViewer;

  if (out.currencySource && (!out.currency || String(out.currency).length !== 3)) {
    out.currency = out.currencySource;
  }

  delete out.securityAnswerHash;
  delete out.securityCode;
  delete out.verificationToken;

  return out;
}

function normalizeTxArray(list = [], viewerUserId = null) {
  return (Array.isArray(list) ? list : []).map((t) =>
    normalizeTxForResponse(t, viewerUserId)
  );
}

function extractTxArrayFromProviderPayload(payload) {
  const candidates = [
    payload?.data,
    payload?.transactions,
    payload?.data?.transactions,
    payload?.data?.data,
    payload?.result,
    payload?.items,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function injectTxArrayIntoProviderPayload(payload, list) {
  if (!payload || typeof payload !== "object") {
    return { success: true, data: list };
  }

  if (Array.isArray(payload.data)) {
    payload.data = list;
    return payload;
  }

  if (Array.isArray(payload.transactions)) {
    payload.transactions = list;
    return payload;
  }

  if (payload.data && Array.isArray(payload.data.transactions)) {
    payload.data.transactions = list;
    return payload;
  }

  if (payload.data && Array.isArray(payload.data.data)) {
    payload.data.data = list;
    return payload;
  }

  payload.data = list;
  payload.success = payload.success ?? true;
  return payload;
}

module.exports = {
  nNum,
  normalizeCurrencyCode,
  toIdStr,
  sameId,
  computeDirectionForViewer,
  buildMoneyView,
  normalizeTxForResponse,
  normalizeTxArray,
  extractTxArrayFromProviderPayload,
  injectTxArrayIntoProviderPayload,
};