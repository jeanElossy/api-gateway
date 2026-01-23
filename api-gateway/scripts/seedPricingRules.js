// "use strict";

// require("dotenv").config();
// const mongoose = require("mongoose");

// const PricingRule = require("../src/models/PricingRule");

// const MONGO_URI =
//   process.env.MONGO_URI_GATEWAY ||
//   process.env.MONGODB_URI ||
//   process.env.DATABASE_URL;

// if (!MONGO_URI) {
//   console.error("❌ MONGO_URI manquant (MONGO_URI / MONGODB_URI / DATABASE_URL).");
//   process.exit(1);
// }

// const now = new Date();

// const baseRules = [
//   // ================= TRANSFER =================
//   {
//     active: true,
//     priority: 100,
//     scope: { txType: "TRANSFER", fromCurrency: "XOF", toCurrency: "EUR", countries: [], operators: [] },
//     amountRange: { min: 0, max: null },
//     fee: { mode: "MIXED", percent: 1.5, fixed: 200, minFee: 200, maxFee: 5000 },
//     fx: { mode: "MARKET", overrideRate: null, markupPercent: 0.8 },
//     notes: "Default TRANSFER XOF->EUR (global)",
//     version: 1,
//     createdAt: now,
//     updatedAt: now,
//   },
//   {
//     active: true,
//     priority: 100,
//     scope: { txType: "TRANSFER", fromCurrency: "EUR", toCurrency: "XOF", countries: [], operators: [] },
//     amountRange: { min: 0, max: null },
//     fee: { mode: "MIXED", percent: 1.2, fixed: 1, minFee: 1, maxFee: 25 },
//     fx: { mode: "MARKET", overrideRate: null, markupPercent: 0.8 },
//     notes: "Default TRANSFER EUR->XOF (global)",
//     version: 1,
//     createdAt: now,
//     updatedAt: now,
//   },

//   // ================= DEPOSIT =================
//   {
//     active: true,
//     priority: 90,
//     scope: { txType: "DEPOSIT", fromCurrency: "XOF", toCurrency: "XOF", countries: [], operators: [] },
//     amountRange: { min: 0, max: null },
//     fee: { mode: "MIXED", percent: 0.8, fixed: 100, minFee: 100, maxFee: 2500 },
//     fx: { mode: "MARKET" },
//     notes: "Default DEPOSIT XOF->XOF (global)",
//     version: 1,
//     createdAt: now,
//     updatedAt: now,
//   },

//   // ================= WITHDRAW =================
//   {
//     active: true,
//     priority: 90,
//     scope: { txType: "WITHDRAW", fromCurrency: "XOF", toCurrency: "XOF", countries: [], operators: [] },
//     amountRange: { min: 0, max: null },
//     fee: { mode: "MIXED", percent: 1.0, fixed: 150, minFee: 150, maxFee: 3000 },
//     fx: { mode: "MARKET" },
//     notes: "Default WITHDRAW XOF->XOF (global)",
//     version: 1,
//     createdAt: now,
//     updatedAt: now,
//   },
// ];

// async function run() {
//   await mongoose.connect(MONGO_URI);
//   console.log("✅ Connected to MongoDB");

//   // Évite de doubler si tu relances le script :
//   // on “upsert” par (txType, fromCurrency, toCurrency, priority)
//   let upserts = 0;

//   for (const r of baseRules) {
//     const q = {
//       active: true,
//       "scope.txType": r.scope.txType,
//       "scope.fromCurrency": r.scope.fromCurrency,
//       "scope.toCurrency": r.scope.toCurrency,
//       priority: r.priority,
//     };

//     const update = { $set: r };

//     const res = await PricingRule.updateOne(q, update, { upsert: true });
//     if (res.upsertedCount || res.modifiedCount) upserts++;
//   }

//   const count = await PricingRule.countDocuments({});
//   console.log(`✅ Seed done. Upserts/updates: ${upserts}. Total rules in DB: ${count}`);

//   await mongoose.disconnect();
//   console.log("👋 Disconnected");
// }

// run().catch((e) => {
//   console.error("❌ Seed error:", e);
//   process.exit(1);
// });
