// File: api-gateway/scripts/migrate-currency.js
"use strict";

const mongoose = require("mongoose");
const path = require("path");

// charge ton modèle Transaction
const Transaction = require(path.join(__dirname, "..", "src", "models", "Transaction"));
const { normalizeCurrency } = require(path.join(__dirname, "..", "src", "utils", "currency"));

function nNum(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
function normCur(v, countryHint = "") {
  const out = normalizeCurrency(v, countryHint);
  return out ? String(out).toUpperCase() : null;
}

function buildPatch(tx) {
  const meta = tx.meta || {};
  const r = meta?.recipientInfo || {};

  const countryHint = tx.country || meta.country || r.country || "";

  const currencySource =
    normCur(tx.currencySource, countryHint) ||
    normCur(meta.currencySource, countryHint) ||
    normCur(meta.selectedCurrency, countryHint) ||
    normCur(r.selectedCurrency, countryHint) ||
    normCur(r.currencySender, countryHint) ||
    normCur(r.senderCurrencySymbol, countryHint) ||
    normCur(meta.senderCurrencySymbol, countryHint) ||
    normCur(tx.currency, countryHint) ||
    null;

  const currencyTarget =
    normCur(tx.currencyTarget, countryHint) ||
    normCur(meta.currencyTarget, countryHint) ||
    normCur(meta.localCurrencySymbol, countryHint) ||
    normCur(r.localCurrencySymbol, countryHint) ||
    null;

  const amountSource =
    nNum(tx.amountSource) ??
    nNum(meta.amountSource) ??
    nNum(meta.amountPayer) ??
    nNum(r.amountPayer) ??
    nNum(meta.amount) ??
    nNum(r.amount) ??
    nNum(tx.amount);

  const amountTarget =
    nNum(tx.amountTarget) ??
    nNum(meta.amountTarget) ??
    nNum(meta.localAmount) ??
    nNum(r.localAmount) ??
    nNum(meta.amountCreator) ??
    nNum(r.amountCreator) ??
    nNum(tx.netAmount) ??
    null;

  const feeSource =
    nNum(tx.feeSource) ??
    nNum(meta.feeSource) ??
    nNum(meta.transactionFees) ??
    nNum(r.transactionFees) ??
    nNum(meta.feeAmount) ??
    nNum(tx.fees) ??
    null;

  const fx =
    nNum(tx.fxRateSourceToTarget) ??
    nNum(meta.fxRateSourceToTarget) ??
    nNum(meta.exchangeRate) ??
    nNum(r.exchangeRate) ??
    nNum(meta.fxPayerToCreator) ??
    nNum(meta?.fxBaseToAdmin?.rate) ??
    null;

  const money = {
    source: amountSource != null && currencySource ? { amount: amountSource, currency: currencySource } : null,
    feeSource: feeSource != null && currencySource ? { amount: feeSource, currency: currencySource } : null,
    target: amountTarget != null && currencyTarget ? { amount: amountTarget, currency: currencyTarget } : null,
    fxRateSourceToTarget: fx != null ? fx : null,
  };

  // legacy currency = source (ISO)
  const legacyCurrency = currencySource || normCur(tx.currency, countryHint) || null;

  const patch = {
    currency: legacyCurrency || tx.currency,
    currencySource: currencySource || tx.currencySource,
    currencyTarget: currencyTarget || tx.currencyTarget,
    amountSource: tx.amountSource != null ? tx.amountSource : amountSource,
    amountTarget: tx.amountTarget != null ? tx.amountTarget : amountTarget,
    feeSource: tx.feeSource != null ? tx.feeSource : feeSource,
    fxRateSourceToTarget: tx.fxRateSourceToTarget != null ? tx.fxRateSourceToTarget : fx,
    money,
    updatedAt: new Date(),
  };

  // nettoie undefined
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined) delete patch[k];
  }

  return patch;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;

  const mongoUri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.DATABASE_URL;

  if (!mongoUri) {
    console.error("❌ MONGO_URI manquant (env).");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("✅ Connected.");

  const query = {
    $or: [
      { currency: { $exists: true, $ne: null, $regex: /[^A-Z]/ } }, // "$CAD", "F CFA", "€"...
      { currencySource: { $exists: false } },
      { currencyTarget: { $exists: false } },
      { money: { $exists: false } },
      { "money.source.currency": { $exists: false } },
      { "money.target.currency": { $exists: false } },
    ],
  };

  const cursor = Transaction.find(query).sort({ createdAt: -1 }).cursor();

  let ops = [];
  let processed = 0;
  let updated = 0;

  for await (const tx of cursor) {
    processed += 1;

    const patch = buildPatch(tx);

    const willUpdate = !!patch && Object.keys(patch).length > 0;
    if (willUpdate) {
      updated += 1;
      ops.push({
        updateOne: {
          filter: { _id: tx._id },
          update: { $set: patch },
        },
      });
    }

    if (ops.length >= 500) {
      if (!dryRun) await Transaction.bulkWrite(ops, { ordered: false });
      console.log(`🔁 batch applied: ${ops.length}`);
      ops = [];
    }

    if (limit > 0 && processed >= limit) break;
  }

  if (ops.length) {
    if (!dryRun) await Transaction.bulkWrite(ops, { ordered: false });
    console.log(`🔁 final batch applied: ${ops.length}`);
  }

  console.log(`✅ done. processed=${processed} updated=${updated} dryRun=${dryRun}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("💥 migrate failed:", e);
  process.exit(1);
});
