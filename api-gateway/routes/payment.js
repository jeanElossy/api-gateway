// routes/payment.js
const express = require('express');
const axios = require('axios');
const router = express.Router();

// URL du service interne PayNoval depuis .env
const PAYNOVAL_URL = process.env.SERVICE_PAYNOVAL_URL || 'https://api-paynoval.onrender.com';

// Route centrale de paiement
router.post('/', async (req, res) => {
  const { provider } = req.body;

  if (provider !== 'paynoval') {
    return res.status(400).json({ error: 'Provider non supporté ici.' });
  }

  try {
    // Forward vers le microservice PayNoval interne
    const response = await axios.post(`${PAYNOVAL_URL}/pay`, req.body, {
      headers: {
        'Authorization': req.headers.authorization, // On forward le JWT pour auth interne
        // + ajoute un header interne sécurisé si besoin
        'x-internal-token': process.env.INTERNAL_TOKEN,
      },
      timeout: 15000, // timeout pour éviter les blocages
    });

    // Renvoie la réponse du service
    res.status(response.status).json(response.data);

  } catch (err) {
    // Logging d'erreur (ici console, à améliorer avec un logger plus tard)
    console.error('[Gateway→PayNoval] Error:', err.response?.data || err.message);
    const status = err.response?.status || 500;
    const error = err.response?.data?.error || 'Erreur interne PayNoval';
    res.status(status).json({ error });
  }
});

module.exports = router;
