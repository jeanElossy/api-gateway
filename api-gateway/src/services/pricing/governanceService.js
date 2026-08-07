"use strict";

/**
 * APPLICATION D'UNE DEMANDE DE CHANGEMENT TARIFAIRE
 * -----------------------------------------------------------------------------
 * Approuver ET publier sont un seul geste. La séquence ci-dessous ne s'appuie
 * sur AUCUNE transaction multi-documents : l'arbitre unique est le $inc gardé
 * de l'étape 3, et les étapes 4-5 sont idempotentes grâce à l'index unique
 * {ruleId, versionNumber} de PricingRuleVersion.
 *
 *   1. Réservation atomique de la demande  (pending_approval -> approved)
 *   2. Contrôle de concurrence             (baseVersion == currentVersion)
 *   3. Publication gardée                  ($inc currentVersion)
 *   4. Snapshot immuable                   (PricingRuleVersion)
 *   5. Clôture                             (approved -> applied)
 *
 * MODE DÉGRADÉ. Un plantage entre 3 et 4 laisse une règle en vN sans snapshot
 * vN. L'état est détectable et réparable en rejouant les étapes 4-5 depuis la
 * demande restée en `approved` : c'est le rôle de `retryApply`.
 */

const PricingRule = require("../../models/PricingRule");
const PricingRuleVersion = require("../../models/PricingRuleVersion");
const PricingChangeRequest = require("../../models/PricingChangeRequest");

const {
  assertCanApprove,
  assertVersionMatches,
  httpError,
} = require("./governanceRules");

/** `req.user` -> acteur stockable. */
function toActor(user) {
  if (!user?._id && !user?.id) {
    throw httpError(401, "Utilisateur non authentifié.");
  }

  return {
    staffId: user._id || user.id,
    email: String(user.email || "").trim(),
    name: String(user.name || user.fullName || user.firstName || "").trim(),
    at: new Date(),
  };
}

/**
 * Photographie des champs pilotés par l'opérateur. Les champs techniques
 * (`_id`, timestamps, `currentVersion`) n'y figurent pas : un journal doit
 * montrer des décisions, pas de la plomberie.
 */
function buildSnapshot(rule) {
  if (!rule) return null;

  const plain = typeof rule.toObject === "function" ? rule.toObject() : rule;

  return {
    name: plain.name ?? null,
    code: plain.code ?? null,
    description: plain.description ?? "",
    notes: plain.notes ?? "",
    active: !!plain.active,
    priority: Number(plain.priority ?? 0),
    category: plain.category ?? "pricing",
    service: plain.service ?? "all",
    scope: plain.scope ?? null,
    countries: plain.countries ?? [],
    operators: plain.operators ?? [],
    amountRange: plain.amountRange ?? { min: 0, max: null },
    fee: plain.fee ?? null,
    fx: plain.fx ?? null,
    startsAt: plain.startsAt ?? null,
    endsAt: plain.endsAt ?? null,
    archivedAt: plain.archivedAt ?? null,
  };
}

/**
 * Étapes 3 à 5, isolées pour être rejouables telles quelles.
 * @returns {Promise<{rule: object, version: object}>}
 */
async function publish({ request, actor }) {
  let rule;

  if (request.action === "create") {
    rule = await PricingRule.create({
      ...request.proposed,
      currentVersion: 1,
      lastChangeRequestId: request._id,
      createdBy: actor.staffId,
      updatedBy: actor.staffId,
    });
  } else {
    const nextVersion = Number(request.baseVersion) + 1;

    const update =
      request.action === "archive"
        ? {
            $inc: { currentVersion: 1 },
            $set: {
              active: false,
              archivedAt: new Date(),
              archivedBy: actor,
              lastChangeRequestId: request._id,
              updatedBy: actor.staffId,
            },
          }
        : {
            $inc: { currentVersion: 1 },
            $set: {
              ...request.proposed,
              lastChangeRequestId: request._id,
              updatedBy: actor.staffId,
            },
          };

    // Garde de concurrence : seul l'appel dont `currentVersion` correspond
    // encore l'emporte. Les autres reçoivent `null`.
    rule = await PricingRule.findOneAndUpdate(
      { _id: request.ruleId, currentVersion: request.baseVersion },
      update,
      { new: true, runValidators: true }
    );

    if (!rule) {
      throw httpError(
        409,
        "La règle a été modifiée entre la validation et la publication. Aucune modification n'a été appliquée."
      );
    }

    if (Number(rule.currentVersion) !== nextVersion) {
      throw httpError(500, "Incohérence de version après publication.");
    }
  }

  // Idempotent : l'index unique {ruleId, versionNumber} absorbe un rejeu.
  let version;
  try {
    version = await PricingRuleVersion.create({
      ruleId: rule._id,
      versionNumber: rule.currentVersion,
      snapshot: buildSnapshot(rule),
      changeRequestId: request._id,
      publishedBy: actor,
      publishedAt: new Date(),
    });
  } catch (err) {
    if (err?.code === 11000) {
      version = await PricingRuleVersion.findOne({
        ruleId: rule._id,
        versionNumber: rule.currentVersion,
      });
    } else {
      throw err;
    }
  }

  return { rule, version };
}

/**
 * @param {{requestId: string, actor: object, breakGlass: {used: boolean, reason: string}|null}} params
 */
async function applyChangeRequest({ requestId, actor, breakGlass }) {
  const staffActor = toActor(actor);

  const pending = await PricingChangeRequest.findById(requestId);
  assertCanApprove({ request: pending, actor, breakGlass });

  const rule =
    pending.ruleId != null ? await PricingRule.findById(pending.ruleId) : null;
  assertVersionMatches({ request: pending, rule });

  // Étape 1 — réservation atomique. Un `null` signifie qu'un autre
  // administrateur a traité la demande entre la lecture et l'écriture.
  const reserved = await PricingChangeRequest.findOneAndUpdate(
    { _id: requestId, status: "pending_approval" },
    {
      $set: {
        status: "approved",
        approvedBy: staffActor,
        breakGlass: {
          used: !!breakGlass?.used,
          reason: breakGlass?.used ? String(breakGlass.reason).trim() : null,
        },
      },
    },
    { new: true }
  );

  if (!reserved) {
    throw httpError(409, "Cette demande vient d'être traitée par un autre administrateur.");
  }

  try {
    const { rule: published, version } = await publish({
      request: reserved,
      actor: staffActor,
    });

    const applied = await PricingChangeRequest.findByIdAndUpdate(
      reserved._id,
      {
        $set: {
          status: "applied",
          appliedAt: new Date(),
          appliedVersionNumber: version?.versionNumber ?? published.currentVersion,
          error: null,
        },
      },
      { new: true }
    );

    return { request: applied, rule: published, version };
  } catch (err) {
    await PricingChangeRequest.findByIdAndUpdate(reserved._id, {
      $set: { status: "failed", error: String(err?.message || err) },
    });
    throw err;
  }
}

/**
 * Rejeu d'une application interrompue. Idempotent : si le snapshot existe déjà,
 * la demande est simplement clôturée.
 */
async function retryApply({ requestId, actor }) {
  const staffActor = toActor(actor);
  const request = await PricingChangeRequest.findById(requestId);

  if (!request) {
    throw httpError(404, "Demande introuvable.");
  }

  if (!["approved", "failed"].includes(request.status)) {
    throw httpError(
      409,
      `Seule une demande approuvée ou en échec peut être rejouée (état : ${request.status}).`
    );
  }

  const rule =
    request.ruleId != null ? await PricingRule.findById(request.ruleId) : null;

  // Cas nominal du mode dégradé : la règle est DÉJÀ publiée en vN, seul le
  // snapshot ou la clôture manque. On ne réapplique pas la modification.
  if (rule && Number(rule.currentVersion) === Number(request.baseVersion) + 1) {
    let version = await PricingRuleVersion.findOne({
      ruleId: rule._id,
      versionNumber: rule.currentVersion,
    });

    if (!version) {
      version = await PricingRuleVersion.create({
        ruleId: rule._id,
        versionNumber: rule.currentVersion,
        snapshot: buildSnapshot(rule),
        changeRequestId: request._id,
        publishedBy: request.approvedBy || staffActor,
        publishedAt: new Date(),
      });
    }

    const applied = await PricingChangeRequest.findByIdAndUpdate(
      request._id,
      {
        $set: {
          status: "applied",
          appliedAt: new Date(),
          appliedVersionNumber: version.versionNumber,
          error: null,
        },
      },
      { new: true }
    );

    return { request: applied, rule, version };
  }

  // La publication n'a pas eu lieu : on rejoue les étapes 3 à 5.
  assertVersionMatches({ request, rule });

  const { rule: published, version } = await publish({
    request,
    actor: request.approvedBy || staffActor,
  });

  const applied = await PricingChangeRequest.findByIdAndUpdate(
    request._id,
    {
      $set: {
        status: "applied",
        appliedAt: new Date(),
        appliedVersionNumber: version?.versionNumber ?? published.currentVersion,
        error: null,
      },
    },
    { new: true }
  );

  return { request: applied, rule: published, version };
}

module.exports = {
  applyChangeRequest,
  retryApply,
  toActor,
  buildSnapshot,
  publish,
};
