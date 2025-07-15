const express = require('express');
const router = express.Router();
const requireAdmin = require('../middleware/requireAdmin');
const ctrl = require('../controllers/commissionsController');

// ENDPOINT PUBLIC pour simuler la commission (AVANT requireAdmin)
router.get('/simulate', ctrl.simulateCagnottePublic);

// Toutes les routes suivantes sont réservées admin !
router.use(requireAdmin);

// CRUD Commissions
router.get('/',     ctrl.list);      // Liste/pagination/recherche
router.post('/',    ctrl.create);    // Ajout
router.put('/:id',  ctrl.update);    // MAJ
router.delete('/:id', ctrl.remove);  // Suppression

module.exports = router;
