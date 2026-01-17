"use strict";

const express = require("express");
const router = express.Router();

const { protect } = require("../src/middlewares/auth");
const ctrl = require("../controllers/phoneVerificationController");

// Auth user
router.get("/status", protect, ctrl.status); // ✅ NEW
router.post("/start", protect, ctrl.start);
router.post("/verify", protect, ctrl.verify);

// optionnel
router.get("/list", protect, ctrl.list);

module.exports = router;
