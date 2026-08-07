"use strict";

/**
 * DEMANDE DE CHANGEMENT TARIFAIRE, SOUMISE À DOUBLE VALIDATION
 * -----------------------------------------------------------------------------
 * Modifier un prix touche TOUTES les transactions des corridors concernés, là
 * où un ajustement de solde n'en touche qu'une. La capacité est donc traitée
 * comme une demande, sur le modèle de `AdminAdjustment`, et non comme une
 * action immédiate.
 *
 * Règle centrale : **`approvedBy` ne peut jamais être égal à `requestedBy`**,
 * sauf dérogation break-glass, réservée au superadmin et motivée. La dérogation
 * est un état visible dans le journal, jamais un contournement silencieux.
 *
 * `PricingRule` ne contient que du tarif publié : tant qu'une demande n'est pas
 * approuvée, son brouillon vit ici et nulle part ailleurs.
 */

const mongoose = require("mongoose");
const { actorSchema } = require("./PricingRuleVersion");

const ACTIONS = ["create", "update", "archive"];

const STATUSES = [
  "pending_approval", // déposée, en attente d'un second valideur
  "approved", // validée, application en cours
  "applied", // publiée, version écrite
  "rejected", // refusée par un second valideur
  "cancelled", // retirée par son auteur
  "failed", // validée mais l'application a échoué
];

const diffEntrySchema = new mongoose.Schema(
  {
    path: { type: String, required: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const pricingChangeRequestSchema = new mongoose.Schema(
  {
    action: { type: String, enum: ACTIONS, required: true },

    /** `null` pour une création : la règle n'existe pas encore. */
    ruleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PricingRule",
      default: null,
      index: true,
    },

    /** `null` pour une action `archive` : rien n'est proposé, seul l'état change. */
    proposed: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * Version sur laquelle s'appuie la demande. `null` pour une création.
     * Si elle ne correspond plus à `PricingRule.currentVersion` au moment
     * d'appliquer, la demande échoue : deux admins ne peuvent pas s'écraser.
     */
    baseVersion: { type: Number, default: null },

    /**
     * Figé au dépôt. Informatif : c'est `baseVersion` qui fait autorité.
     * L'écran de validation doit signaler un diff périmé plutôt que de
     * l'afficher comme s'il était à jour.
     */
    diff: { type: [diffEntrySchema], default: [] },

    status: {
      type: String,
      enum: STATUSES,
      default: "pending_approval",
      index: true,
    },

    reason: { type: String, required: true, trim: true, maxlength: 1000 },

    requestedBy: { type: actorSchema, required: true },
    approvedBy: { type: actorSchema, default: null },
    rejectedBy: { type: actorSchema, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 1000, default: null },

    breakGlass: {
      used: { type: Boolean, default: false },
      reason: { type: String, trim: true, maxlength: 1000, default: null },
    },

    appliedAt: { type: Date, default: null },
    appliedVersionNumber: { type: Number, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);

// File d'attente des validations : écran principal du module.
pricingChangeRequestSchema.index({ status: 1, createdAt: -1 });
// Historique des demandes portant sur une règle donnée.
pricingChangeRequestSchema.index({ ruleId: 1, createdAt: -1 });

pricingChangeRequestSchema.statics.ACTIONS = ACTIONS;
pricingChangeRequestSchema.statics.STATUSES = STATUSES;

module.exports =
  mongoose.models.PricingChangeRequest ||
  mongoose.model("PricingChangeRequest", pricingChangeRequestSchema);

module.exports.ACTIONS = ACTIONS;
module.exports.STATUSES = STATUSES;
