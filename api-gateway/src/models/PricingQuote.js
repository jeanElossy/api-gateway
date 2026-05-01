// "use strict";

// const mongoose = require("mongoose");

// const PricingQuoteSchema = new mongoose.Schema(
//   {
//     quoteId: {
//       type: String,
//       required: true,
//       unique: true,
//       index: true,
//       trim: true,
//     },

//     userId: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "User",
//       required: true,
//       index: true,
//     },

//     status: {
//       type: String,
//       enum: ["ACTIVE", "USED", "EXPIRED"],
//       default: "ACTIVE",
//       index: true,
//     },

//     request: {
//       txType: { type: String, required: true, uppercase: true },
//       method: { type: String, default: null, uppercase: true },

//       amount: { type: Number, required: true, min: 0 },

//       fromCurrency: { type: String, required: true, uppercase: true },
//       toCurrency: { type: String, required: true, uppercase: true },

//       country: { type: String, default: null, uppercase: true },
//       fromCountry: { type: String, default: null, uppercase: true },
//       toCountry: { type: String, default: null, uppercase: true },

//       operator: { type: String, default: null, lowercase: true },
//       provider: { type: String, default: null, lowercase: true },
//     },

//     result: {
//       marketRate: { type: Number, default: null },
//       appliedRate: { type: Number, required: true },

//       fee: { type: Number, required: true, default: 0 },
//       feeBreakdown: { type: Object, default: {} },

//       grossFrom: { type: Number, required: true },
//       netFrom: { type: Number, required: true },
//       netTo: { type: Number, required: true },

//       /**
//        * ✅ Revenu frais pour l’admin
//        * - amount = frais dans la devise source
//        * - amountCAD = frais convertis en CAD
//        */
//       feeRevenue: {
//         sourceCurrency: { type: String, default: null, uppercase: true },
//         amount: { type: Number, default: 0 },
//         adminCurrency: { type: String, default: "CAD", uppercase: true },
//         amountCAD: { type: Number, default: 0 },
//         conversionRateToCAD: { type: Number, default: 0 },
//         calculatedAt: { type: Date, default: null },
//       },

//       /**
//        * ✅ Revenu FX pour l’admin
//        * - amount = gain FX dans la devise de réception
//        * - amountCAD = gain FX converti en CAD
//        */
//       fxRevenue: {
//         toCurrency: { type: String, default: null, uppercase: true },
//         amount: { type: Number, default: 0 },
//         rawAmount: { type: Number, default: 0 },
//         idealNetTo: { type: Number, default: 0 },
//         actualNetTo: { type: Number, default: 0 },

//         adminCurrency: { type: String, default: "CAD", uppercase: true },
//         amountCAD: { type: Number, default: 0 },
//         conversionRateToCAD: { type: Number, default: 0 },
//         calculatedAt: { type: Date, default: null },
//       },
//     },

//     ruleApplied: {
//       type: Object,
//       default: null,
//     },

//     fxRuleApplied: {
//       type: Object,
//       default: null,
//     },

//     debug: {
//       type: Object,
//       default: null,
//     },

//     expiresAt: {
//       type: Date,
//       required: true,
//       index: true,
//     },
//   },
//   {
//     timestamps: true,
//     versionKey: false,
//   }
// );

// PricingQuoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// module.exports =
//   mongoose.models.PricingQuote ||
//   mongoose.model("PricingQuote", PricingQuoteSchema);





"use strict";

const mongoose = require("mongoose");

const PricingQuoteSchema = new mongoose.Schema(
  {
    quoteId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "USED", "EXPIRED"],
      default: "ACTIVE",
      index: true,
    },

    request: {
      txType: {
        type: String,
        required: true,
        uppercase: true,
      },

      method: {
        type: String,
        default: null,
        uppercase: true,
      },

      amount: {
        type: Number,
        required: true,
        min: 0,
      },

      fromCurrency: {
        type: String,
        required: true,
        uppercase: true,
      },

      toCurrency: {
        type: String,
        required: true,
        uppercase: true,
      },

      country: {
        type: String,
        default: null,
        uppercase: true,
      },

      fromCountry: {
        type: String,
        default: null,
        uppercase: true,
      },

      toCountry: {
        type: String,
        default: null,
        uppercase: true,
      },

      operator: {
        type: String,
        default: null,
        lowercase: true,
      },

      provider: {
        type: String,
        default: null,
        lowercase: true,
      },
    },

    result: {
      marketRate: {
        type: Number,
        default: null,
      },

      appliedRate: {
        type: Number,
        required: true,
      },

      fee: {
        type: Number,
        required: true,
        default: 0,
      },

      feeBreakdown: {
        type: Object,
        default: {},
      },

      grossFrom: {
        type: Number,
        required: true,
      },

      netFrom: {
        type: Number,
        required: true,
      },

      netTo: {
        type: Number,
        required: true,
      },

      feeRevenue: {
        sourceCurrency: {
          type: String,
          default: null,
          uppercase: true,
        },

        amount: {
          type: Number,
          default: 0,
        },

        adminCurrency: {
          type: String,
          default: "CAD",
          uppercase: true,
        },

        amountCAD: {
          type: Number,
          default: 0,
        },

        conversionRateToCAD: {
          type: Number,
          default: 0,
        },

        calculatedAt: {
          type: Date,
          default: null,
        },
      },

      fxRevenue: {
        toCurrency: {
          type: String,
          default: null,
          uppercase: true,
        },

        amount: {
          type: Number,
          default: 0,
        },

        rawAmount: {
          type: Number,
          default: 0,
        },

        idealNetTo: {
          type: Number,
          default: 0,
        },

        actualNetTo: {
          type: Number,
          default: 0,
        },

        adminCurrency: {
          type: String,
          default: "CAD",
          uppercase: true,
        },

        amountCAD: {
          type: Number,
          default: 0,
        },

        conversionRateToCAD: {
          type: Number,
          default: 0,
        },

        calculatedAt: {
          type: Date,
          default: null,
        },
      },
    },

    ruleApplied: {
      type: Object,
      default: null,
    },

    fxRuleApplied: {
      type: Object,
      default: null,
    },

    debug: {
      type: Object,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

/**
 * Index TTL :
 * MongoDB supprimera automatiquement le document quand expiresAt est dépassé.
 * Ne pas ajouter `index: true` directement sur expiresAt, sinon Mongoose affiche :
 * Duplicate schema index on {"expiresAt":1}
 */
PricingQuoteSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

/**
 * Index utile pour retrouver rapidement les quotes actives d’un utilisateur.
 */
PricingQuoteSchema.index({
  userId: 1,
  status: 1,
  createdAt: -1,
});

module.exports =
  mongoose.models.PricingQuote ||
  mongoose.model("PricingQuote", PricingQuoteSchema);