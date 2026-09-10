// File: routes/aml.js
"use strict";

/**
 * ============================================================================
 * JOURNAL AML — RELAIS VERS TX-CORE
 * ============================================================================
 *
 * ── Ce que faisait ce fichier ───────────────────────────────────────────────
 *
 *     const AMLLog = require("../src/models/AMLLog");
 *     router.get("/logs", requireRole([...]), async (req, res) => {
 *       const logs = await AMLLog.find().sort({ createdAt: -1 }).limit(100);
 *       res.json(logs);
 *     });
 *
 * Onze lignes qui lisaient le journal AML de la base de la PASSERELLE. Depuis
 * que l'AML vit dans Tx-Core (2026-09-10), ce journal-là ne reçoit plus rien :
 * la route aurait continué de rendre 200 avec des entrées figées, et personne
 * n'aurait su qu'elle regardait un journal mort.
 *
 * ── Ce qu'elle fait maintenant ──────────────────────────────────────────────
 *
 * Elle relaie vers `/api/v1/internal/admin/aml/logs`, servi par le service qui
 * ÉCRIT le journal. Le bord vérifie le jeton et le rôle — c'est son travail —
 * puis transporte l'identité établie. Il ne lit plus.
 */

const express = require("express");

const { requireRole } = require("../src/middlewares/authz");
const { relayerVers } = require("../src/services/txCoreRelay");

const router = express.Router();

router.get(
  "/logs",
  requireRole(["admin", "superadmin"]),
  relayerVers("/api/v1/internal/admin/aml")
);

module.exports = router;
