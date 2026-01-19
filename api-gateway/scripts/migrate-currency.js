// "use strict";

// require("dotenv").config();

// const mongoose = require("mongoose");
// const path = require("path");

// // ------------------ charge normalizeCurrency (obligatoire) ------------------
// let normalizeCurrency;
// try {
//   ({ normalizeCurrency } = require(path.join(__dirname, "..", "src", "utils", "currency")));
// } catch (e1) {
//   try {
//     ({ normalizeCurrency } = require(path.join(__dirname, "..", "utils", "currency")));
//   } catch (e2) {
//     console.error("❌ Impossible de charger normalizeCurrency.");
//     console.error("   Attendu: src/utils/currency.js ou utils/currency.js");
//     process.exit(1);
//   }
// }

// // ------------------ args ------------------
// function argValue(prefix) {
//   const a = process.argv.find((x) => x.startsWith(prefix));
//   return a ? a.slice(prefix.length) : null;
// }

// const dryRun = process.argv.includes("--dry-run");
// const verbose = process.argv.includes("--verbose");
// const limit = Number(argValue("--limit=") || "0") || 0;
// const forcedCollection = argValue("--collection="); // ex: transactions
// const onlyId = argValue("--id="); // ex: 694eec0b57e20dc07bfbbefb

// // ------------------ helpers ------------------
// function nNum(v) {
//   const x = Number(v);
//   return Number.isFinite(x) ? x : null;
// }

// function normCur(v, countryHint = "") {
//   const out = normalizeCurrency(v, countryHint);
//   const s = out ? String(out).trim().toUpperCase() : "";
//   return s || null;
// }

// function getByPath(obj, pathStr) {
//   try {
//     const parts = String(pathStr).split(".");
//     let cur = obj;
//     for (const p of parts) {
//       if (cur == null) return undefined;
//       cur = cur[p];
//     }
//     return cur;
//   } catch {
//     return undefined;
//   }
// }

// function stableSerialize(v) {
//   if (v == null) return "null";
//   if (typeof v !== "object") return JSON.stringify(v);
//   if (v instanceof Date) return JSON.stringify(v.toISOString());
//   if (Array.isArray(v)) return `[${v.map(stableSerialize).join(",")}]`;

//   if (typeof v.toString === "function" && v.toString !== Object.prototype.toString) {
//     const s = v.toString();
//     if (s && s !== "[object Object]") return JSON.stringify(s);
//   }

//   const keys = Object.keys(v).sort();
//   const parts = keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(v[k])}`);
//   return `{${parts.join(",")}}`;
// }

// function deepEqual(a, b) {
//   return stableSerialize(a) === stableSerialize(b);
// }

// function setIfDiff($set, doc, pathStr, value) {
//   if (value === undefined || value === null) return;
//   const current = getByPath(doc, pathStr);

//   const same =
//     (typeof value === "object" || typeof current === "object")
//       ? deepEqual(current, value)
//       : String(current) === String(value);

//   if (!same) $set[pathStr] = value;
// }

// function resolveMongoUri() {
//   return (
//     process.env.MONGO_URI_GATEWAY ||
//     process.env.MONGO_URI ||
//     process.env.MONGODB_URI ||
//     process.env.DATABASE_URL ||
//     ""
//   );
// }

// // ------------------ patch builder ------------------
// function buildPatch(doc) {
//   const meta = doc?.meta || {};
//   const r = meta?.recipientInfo || {};
//   const countryHint = doc.country || meta.country || r.country || "";

//   const currencySource =
//     normCur(doc.currencySource, countryHint) ||
//     normCur(meta.currencySource, countryHint) ||
//     normCur(meta.selectedCurrency, countryHint) ||
//     normCur(r.selectedCurrency, countryHint) ||
//     normCur(r.currencySender, countryHint) ||
//     normCur(r.senderCurrencySymbol, countryHint) ||
//     normCur(meta.senderCurrencySymbol, countryHint) ||
//     normCur(doc.currency, countryHint) ||
//     null;

//   const currencyTarget =
//     normCur(doc.currencyTarget, countryHint) ||
//     normCur(meta.currencyTarget, countryHint) ||
//     normCur(meta.localCurrencySymbol, countryHint) ||
//     normCur(r.localCurrencySymbol, countryHint) ||
//     null;

//   const amountSource =
//     nNum(doc.amountSource) ??
//     nNum(meta.amountSource) ??
//     nNum(meta.amountPayer) ??
//     nNum(r.amountPayer) ??
//     nNum(meta.amount) ??
//     nNum(r.amount) ??
//     nNum(doc.amount);

//   const amountTarget =
//     nNum(doc.amountTarget) ??
//     nNum(meta.amountTarget) ??
//     nNum(meta.localAmount) ??
//     nNum(r.localAmount) ??
//     nNum(meta.amountCreator) ??
//     nNum(r.amountCreator) ??
//     nNum(doc.netAmount) ??
//     null;

//   const feeSource =
//     nNum(doc.feeSource) ??
//     nNum(meta.feeSource) ??
//     nNum(meta.transactionFees) ??
//     nNum(r.transactionFees) ??
//     nNum(meta.feeAmount) ??
//     nNum(doc.fees) ??
//     null;

//   const fx =
//     nNum(doc.fxRateSourceToTarget) ??
//     nNum(meta.fxRateSourceToTarget) ??
//     nNum(meta.exchangeRate) ??
//     nNum(r.exchangeRate) ??
//     nNum(meta.fxPayerToCreator) ??
//     nNum(meta?.fxBaseToAdmin?.rate) ??
//     null;

//   const legacyCurrency = currencySource || normCur(doc.currency, countryHint) || null;

//   const $set = {};

//   // top-level (ISO)
//   if (legacyCurrency) setIfDiff($set, doc, "currency", legacyCurrency);
//   if (currencySource) setIfDiff($set, doc, "currencySource", currencySource);
//   if (currencyTarget) setIfDiff($set, doc, "currencyTarget", currencyTarget);

//   // numbers: only set if missing
//   if (amountSource != null && doc.amountSource == null) setIfDiff($set, doc, "amountSource", amountSource);
//   if (amountTarget != null && doc.amountTarget == null) setIfDiff($set, doc, "amountTarget", amountTarget);
//   if (feeSource != null && doc.feeSource == null) setIfDiff($set, doc, "feeSource", feeSource);
//   if (fx != null && doc.fxRateSourceToTarget == null) setIfDiff($set, doc, "fxRateSourceToTarget", fx);

//   // money
//   const hasMoney = doc.money && typeof doc.money === "object";
//   const money = {
//     source: amountSource != null && currencySource ? { amount: amountSource, currency: currencySource } : null,
//     feeSource: feeSource != null && currencySource ? { amount: feeSource, currency: currencySource } : null,
//     target: amountTarget != null && currencyTarget ? { amount: amountTarget, currency: currencyTarget } : null,
//     fxRateSourceToTarget: fx != null ? fx : null,
//   };

//   if (!hasMoney) {
//     if (money.source || money.target) setIfDiff($set, doc, "money", money);
//   } else {
//     if (!doc?.money?.source && money.source) setIfDiff($set, doc, "money.source", money.source);
//     if (!doc?.money?.feeSource && money.feeSource) setIfDiff($set, doc, "money.feeSource", money.feeSource);
//     if (!doc?.money?.target && money.target) setIfDiff($set, doc, "money.target", money.target);
//     if ((doc?.money?.fxRateSourceToTarget == null || doc?.money?.fxRateSourceToTarget === 0) && fx != null) {
//       setIfDiff($set, doc, "money.fxRateSourceToTarget", fx);
//     }
//   }

//   // ✅ recipientInfo legacy alignment (ISO) — sans condition “rObj”
//   // (MongoDB créera les sous-objets si absents)
//   const rPath = "meta.recipientInfo";
//   if (currencySource) {
//     setIfDiff($set, doc, `${rPath}.currencySource`, currencySource);
//     setIfDiff($set, doc, `${rPath}.selectedCurrency`, currencySource);
//     setIfDiff($set, doc, `${rPath}.currencySender`, currencySource);
//     setIfDiff($set, doc, `${rPath}.senderCurrencySymbol`, currencySource);
//   }
//   if (currencyTarget) {
//     setIfDiff($set, doc, `${rPath}.currencyTarget`, currencyTarget);
//     setIfDiff($set, doc, `${rPath}.localCurrencySymbol`, currencyTarget);
//   }
//   if (amountSource != null) setIfDiff($set, doc, `${rPath}.amountSource`, amountSource);
//   if (amountTarget != null) setIfDiff($set, doc, `${rPath}.amountTarget`, amountTarget);
//   if (feeSource != null) setIfDiff($set, doc, `${rPath}.feeSource`, feeSource);
//   if (fx != null) setIfDiff($set, doc, `${rPath}.fxRateSourceToTarget`, fx);

//   if (Object.keys($set).length > 0) $set.updatedAt = new Date();

//   return $set;
// }

// // ------------------ main ------------------
// async function main() {
//   const mongoUri = resolveMongoUri();
//   if (!mongoUri) {
//     console.error("❌ MONGO_URI_GATEWAY (ou MONGO_URI) manquant.");
//     process.exit(1);
//   }

//   console.log("🔧 Using Mongo URI:", mongoUri.replace(/\/\/.*@/, "//***:***@"));

//   await mongoose.connect(mongoUri);
//   const db = mongoose.connection.db;
//   const dbName = db.databaseName;

//   // ✅ collection choisie
//   const collectionName = forcedCollection || "transactions";
//   const col = db.collection(collectionName);

//   console.log("✅ Connected to MongoDB. db=", dbName, " collection=", collectionName);

//   // test rapide : si tu passes --id, on cible 1 doc précis
//   const query = onlyId
//     ? { _id: new mongoose.Types.ObjectId(String(onlyId)) }
//     : {
//         $or: [
//           { "meta.recipientInfo.currencySender": { $in: ["$CAD", "$USD", "F CFA", "FCFA", "CFA", "€", "£"] } },
//           { "meta.recipientInfo.senderCurrencySymbol": { $in: ["$CAD", "$USD", "F CFA", "FCFA", "CFA", "€", "£"] } },
//           { "meta.recipientInfo.localCurrencySymbol": { $in: ["$CAD", "$USD", "F CFA", "FCFA", "CFA", "€", "£"] } },
//           { "meta.recipientInfo.selectedCurrency": { $in: ["$CAD", "$USD", "F CFA", "FCFA", "CFA", "€", "£"] } },
//           { currency: { $exists: true, $ne: null, $regex: /[^A-Z]/ } },
//           { money: { $exists: false } },
//           { currencySource: { $exists: false } },
//           { currencyTarget: { $exists: false } },
//         ],
//       };

//   const cursor = col.find(query).sort({ createdAt: -1 });

//   let ops = [];
//   let processed = 0;
//   let updated = 0;

//   while (await cursor.hasNext()) {
//     const doc = await cursor.next();
//     processed += 1;

//     const $set = buildPatch(doc);
//     if ($set && Object.keys($set).length > 0) {
//       updated += 1;

//       if (verbose) {
//         const before = getByPath(doc, "meta.recipientInfo.currencySender");
//         const after = $set["meta.recipientInfo.currencySender"];
//         console.log("•", String(doc._id), "keys:", Object.keys($set).length, " currencySender:", before, "=>", after);
//       }

//       ops.push({
//         updateOne: {
//           filter: { _id: doc._id },
//           update: { $set },
//         },
//       });
//     }

//     if (ops.length >= 500) {
//       if (!dryRun) {
//         await col.bulkWrite(ops, { ordered: false });
//         console.log(`🔁 batch applied: ${ops.length}`);
//       } else {
//         console.log(`🧪 dry-run would apply batch: ${ops.length}`);
//       }
//       ops = [];
//     }

//     if (limit > 0 && processed >= limit) break;
//   }

//   if (ops.length) {
//     if (!dryRun) {
//       await col.bulkWrite(ops, { ordered: false });
//       console.log(`🔁 final batch applied: ${ops.length}`);
//     } else {
//       console.log(`🧪 dry-run would apply final batch: ${ops.length}`);
//     }
//   }

//   console.log(`✅ done. processed=${processed} updated=${updated} dryRun=${dryRun}`);
//   await mongoose.disconnect();
// }

// main().catch((e) => {
//   console.error("💥 migrate failed:", e);
//   process.exit(1);
// });
