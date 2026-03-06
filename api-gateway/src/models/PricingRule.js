// "use strict";

// const mongoose = require("mongoose");

// const AmountRangeSchema = new mongoose.Schema(
//   {
//     min: { type: Number, default: 0, min: 0 },
//     max: { type: Number, default: null },
//   },
//   { _id: false }
// );

// const FeeSchema = new mongoose.Schema(
//   {
//     mode: {
//       type: String,
//       enum: ["NONE", "FIXED", "PERCENT", "MIXED"],
//       default: "NONE",
//     },
//     fixed: { type: Number, default: 0, min: 0 },
//     percent: { type: Number, default: 0, min: 0 },
//     minFee: { type: Number, default: null, min: 0 },
//     maxFee: { type: Number, default: null, min: 0 },
//   },
//   { _id: false }
// );

// const FxSchema = new mongoose.Schema(
//   {
//     mode: {
//       type: String,
//       enum: ["PASS_THROUGH", "OVERRIDE", "MARKUP_PERCENT", "DELTA_PERCENT", "DELTA_ABS"],
//       default: "PASS_THROUGH",
//     },
//     overrideRate: { type: Number, default: null },
//     markupPercent: { type: Number, default: 0 },
//     percent: { type: Number, default: 0 },
//     deltaAbs: { type: Number, default: 0 },
//     notes: { type: String, default: "" },
//   },
//   { _id: false }
// );

// const ScopeSchema = new mongoose.Schema(
//   {
//     txType: {
//       type: String,
//       enum: ["TRANSFER", "DEPOSIT", "WITHDRAW", "ALL"],
//       default: "ALL",
//       index: true,
//     },

//     method: {
//       type: String,
//       enum: ["MOBILEMONEY", "BANK", "CARD", "INTERNAL", "ALL"],
//       default: "ALL",
//       index: true,
//     },

//     provider: {
//       type: String,
//       trim: true,
//       lowercase: true,
//       default: "all",
//       index: true,
//     },

//     country: {
//       type: String,
//       trim: true,
//       uppercase: true,
//       default: "ALL",
//       index: true,
//     },

//     fromCountry: {
//       type: String,
//       trim: true,
//       uppercase: true,
//       default: "ALL",
//       index: true,
//     },

//     toCountry: {
//       type: String,
//       trim: true,
//       uppercase: true,
//       default: "ALL",
//       index: true,
//     },

//     fromCurrency: {
//       type: String,
//       trim: true,
//       uppercase: true,
//       required: true,
//       index: true,
//     },

//     toCurrency: {
//       type: String,
//       trim: true,
//       uppercase: true,
//       required: true,
//       index: true,
//     },
//   },
//   { _id: false }
// );

// const PricingRuleSchema = new mongoose.Schema(
//   {
//     name: {
//       type: String,
//       required: true,
//       trim: true,
//       maxlength: 160,
//       index: true,
//     },

//     code: {
//       type: String,
//       trim: true,
//       uppercase: true,
//       maxlength: 80,
//       sparse: true,
//       index: true,
//     },

//     description: {
//       type: String,
//       trim: true,
//       default: "",
//       maxlength: 500,
//     },

//     notes: {
//       type: String,
//       trim: true,
//       default: "",
//     },

//     active: {
//       type: Boolean,
//       default: true,
//       index: true,
//     },

//     priority: {
//       type: Number,
//       default: 0,
//       index: true,
//     },

//     category: {
//       type: String,
//       enum: ["fee", "fx", "pricing", "other"],
//       default: "pricing",
//       index: true,
//     },

//     service: {
//       type: String,
//       trim: true,
//       default: "all",
//       index: true,
//     },

//     scope: {
//       type: ScopeSchema,
//       required: true,
//     },

//     countries: [
//       {
//         type: String,
//         trim: true,
//         uppercase: true,
//       },
//     ],

//     operators: [
//       {
//         type: String,
//         trim: true,
//         lowercase: true,
//       },
//     ],

//     amountRange: {
//       type: AmountRangeSchema,
//       default: () => ({ min: 0, max: null }),
//     },

//     fee: {
//       type: FeeSchema,
//       default: () => ({ mode: "NONE" }),
//     },

//     fx: {
//       type: FxSchema,
//       default: () => ({ mode: "PASS_THROUGH" }),
//     },

//     startsAt: {
//       type: Date,
//       default: null,
//       index: true,
//     },

//     endsAt: {
//       type: Date,
//       default: null,
//       index: true,
//     },

//     version: {
//       type: Number,
//       default: 1,
//     },

//     metadata: {
//       type: mongoose.Schema.Types.Mixed,
//       default: {},
//     },

//     createdBy: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "User",
//       default: null,
//     },

//     updatedBy: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "User",
//       default: null,
//     },
//   },
//   {
//     timestamps: true,
//     versionKey: false,
//   }
// );

// PricingRuleSchema.index(
//   {
//     active: 1,
//     "scope.txType": 1,
//     "scope.method": 1,
//     "scope.provider": 1,
//     "scope.country": 1,
//     "scope.fromCountry": 1,
//     "scope.toCountry": 1,
//     "scope.fromCurrency": 1,
//     "scope.toCurrency": 1,
//     priority: -1,
//     updatedAt: -1,
//   },
//   { name: "pricing_rule_match_idx" }
// );

// PricingRuleSchema.pre("validate", function (next) {
//   try {
//     if (this.code) this.code = String(this.code).trim().toUpperCase();

//     if (this.scope) {
//       if (this.scope.provider) this.scope.provider = String(this.scope.provider).trim().toLowerCase();
//       if (this.scope.country) this.scope.country = String(this.scope.country).trim().toUpperCase();
//       if (this.scope.fromCountry) this.scope.fromCountry = String(this.scope.fromCountry).trim().toUpperCase();
//       if (this.scope.toCountry) this.scope.toCountry = String(this.scope.toCountry).trim().toUpperCase();
//       if (this.scope.fromCurrency) this.scope.fromCurrency = String(this.scope.fromCurrency).trim().toUpperCase();
//       if (this.scope.toCurrency) this.scope.toCurrency = String(this.scope.toCurrency).trim().toUpperCase();
//     }

//     if (Array.isArray(this.countries)) {
//       this.countries = this.countries.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
//     }

//     if (Array.isArray(this.operators)) {
//       this.operators = this.operators.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
//     }

//     if (this.startsAt && this.endsAt && this.endsAt < this.startsAt) {
//       return next(new Error("endsAt must be greater than or equal to startsAt"));
//     }

//     if (
//       this.amountRange &&
//       this.amountRange.max != null &&
//       this.amountRange.min > this.amountRange.max
//     ) {
//       return next(new Error("amountRange.min cannot be greater than amountRange.max"));
//     }

//     if (
//       this.fee &&
//       this.fee.minFee != null &&
//       this.fee.maxFee != null &&
//       this.fee.minFee > this.fee.maxFee
//     ) {
//       return next(new Error("fee.minFee cannot be greater than fee.maxFee"));
//     }

//     next();
//   } catch (err) {
//     next(err);
//   }
// });

// module.exports =
//   mongoose.models.PricingRule ||
//   mongoose.model("PricingRule", PricingRuleSchema);




"use strict";

const mongoose = require("mongoose");

const AmountRangeSchema = new mongoose.Schema(
  {
    min: { type: Number, default: 0, min: 0 },
    max: { type: Number, default: null },
  },
  { _id: false }
);

const FeeSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ["NONE", "FIXED", "PERCENT", "MIXED"],
      default: "NONE",
    },
    fixed: { type: Number, default: 0, min: 0 },
    percent: { type: Number, default: 0, min: 0 },
    minFee: { type: Number, default: null, min: 0 },
    maxFee: { type: Number, default: null, min: 0 },
  },
  { _id: false }
);

const FxSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ["PASS_THROUGH", "OVERRIDE", "MARKUP_PERCENT", "DELTA_PERCENT", "DELTA_ABS"],
      default: "PASS_THROUGH",
    },

    // OVERRIDE
    overrideRate: { type: Number, default: null },

    // MARKUP_PERCENT => client rate = marketRate * (1 - markupPercent/100)
    markupPercent: { type: Number, default: 0 },

    // DELTA_PERCENT => client rate = marketRate * (1 + percent/100)
    percent: { type: Number, default: 0 },

    // DELTA_ABS => client rate = marketRate + deltaAbs
    deltaAbs: { type: Number, default: 0 },

    notes: { type: String, default: "" },
  },
  { _id: false }
);

const ScopeSchema = new mongoose.Schema(
  {
    txType: {
      type: String,
      enum: ["TRANSFER", "DEPOSIT", "WITHDRAW", "ALL"],
      default: "ALL",
      index: true,
    },

    method: {
      type: String,
      enum: ["MOBILEMONEY", "BANK", "CARD", "INTERNAL", "ALL"],
      default: "ALL",
      index: true,
    },

    provider: {
      type: String,
      trim: true,
      lowercase: true,
      default: "all",
      index: true,
    },

    country: {
      type: String,
      trim: true,
      uppercase: true,
      default: "ALL",
      index: true,
    },

    fromCountry: {
      type: String,
      trim: true,
      uppercase: true,
      default: "ALL",
      index: true,
    },

    toCountry: {
      type: String,
      trim: true,
      uppercase: true,
      default: "ALL",
      index: true,
    },

    fromCurrency: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      index: true,
    },

    toCurrency: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      index: true,
    },
  },
  { _id: false }
);

const PricingRuleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      index: true,
    },

    code: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 80,
      sparse: true,
      index: true,
    },

    description: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
    },

    notes: {
      type: String,
      trim: true,
      default: "",
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    priority: {
      type: Number,
      default: 0,
      index: true,
    },

    category: {
      type: String,
      enum: ["fee", "fx", "pricing", "other"],
      default: "pricing",
      index: true,
    },

    service: {
      type: String,
      trim: true,
      default: "all",
      index: true,
    },

    scope: {
      type: ScopeSchema,
      required: true,
    },

    countries: [
      {
        type: String,
        trim: true,
        uppercase: true,
      },
    ],

    operators: [
      {
        type: String,
        trim: true,
        lowercase: true,
      },
    ],

    amountRange: {
      type: AmountRangeSchema,
      default: () => ({ min: 0, max: null }),
    },

    fee: {
      type: FeeSchema,
      default: () => ({ mode: "NONE" }),
    },

    fx: {
      type: FxSchema,
      default: () => ({ mode: "PASS_THROUGH" }),
    },

    startsAt: {
      type: Date,
      default: null,
      index: true,
    },

    endsAt: {
      type: Date,
      default: null,
      index: true,
    },

    version: {
      type: Number,
      default: 1,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

/**
 * ✅ Index principal de matching
 */
PricingRuleSchema.index(
  {
    active: 1,
    "scope.txType": 1,
    "scope.method": 1,
    "scope.provider": 1,
    "scope.country": 1,
    "scope.fromCountry": 1,
    "scope.toCountry": 1,
    "scope.fromCurrency": 1,
    "scope.toCurrency": 1,
    priority: -1,
    updatedAt: -1,
  },
  { name: "pricing_rule_match_idx" }
);

PricingRuleSchema.pre("validate", function (next) {
  try {
    if (this.code) this.code = String(this.code).trim().toUpperCase();

    if (this.scope) {
      if (this.scope.provider) this.scope.provider = String(this.scope.provider).trim().toLowerCase();
      if (this.scope.country) this.scope.country = String(this.scope.country).trim().toUpperCase();
      if (this.scope.fromCountry) this.scope.fromCountry = String(this.scope.fromCountry).trim().toUpperCase();
      if (this.scope.toCountry) this.scope.toCountry = String(this.scope.toCountry).trim().toUpperCase();
      if (this.scope.fromCurrency) this.scope.fromCurrency = String(this.scope.fromCurrency).trim().toUpperCase();
      if (this.scope.toCurrency) this.scope.toCurrency = String(this.scope.toCurrency).trim().toUpperCase();
    }

    if (this.service) {
      this.service = String(this.service).trim().toLowerCase();
    }

    if (Array.isArray(this.countries)) {
      this.countries = this.countries.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    }

    if (Array.isArray(this.operators)) {
      this.operators = this.operators.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    }

    if (this.startsAt && this.endsAt && this.endsAt < this.startsAt) {
      return next(new Error("endsAt must be greater than or equal to startsAt"));
    }

    if (
      this.amountRange &&
      this.amountRange.max != null &&
      this.amountRange.min > this.amountRange.max
    ) {
      return next(new Error("amountRange.min cannot be greater than amountRange.max"));
    }

    if (
      this.fee &&
      this.fee.minFee != null &&
      this.fee.maxFee != null &&
      this.fee.minFee > this.fee.maxFee
    ) {
      return next(new Error("fee.minFee cannot be greater than fee.maxFee"));
    }

    next();
  } catch (err) {
    next(err);
  }
});

module.exports =
  mongoose.models.PricingRule ||
  mongoose.model("PricingRule", PricingRuleSchema);