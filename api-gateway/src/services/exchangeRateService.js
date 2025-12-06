// // File: src/services/exchangeRateService.js
// 'use strict';

// const ExchangeRate = require('../models/ExchangeRate'); // adapte le chemin si besoin
// const axios = require('axios');
// const { normalizeCurrency } = require('../utils/currency');

// const FX_API_BASE_URL =
//   process.env.FX_API_BASE_URL || 'https://v6.exchangerate-api.com/v6';
// const FX_API_KEY = process.env.FX_API_KEY || '';

// console.log('[FX] exchangeRateService initialisé', {
//   FX_API_BASE_URL,
//   hasKey: !!FX_API_KEY,
// });

// /**
//  * Récupère le taux de change dynamique :
//  * 1) Si from == to => 1
//  * 2) Si un taux custom admin est en DB => ce taux
//  * 3) Sinon API externe (exchangerate-api)
//  * 4) Sinon fallback => 1
//  *
//  * @param {string} from - Devise de départ (ex: EUR, F CFA, $...)
//  * @param {string} to   - Devise d’arrivée (ex: XOF, USD...)
//  * @returns {Promise<number>} - Taux (ex: 655.957)
//  */
// async function getExchangeRate(from, to) {
//   console.log('[FX] getExchangeRate() called with raw values =', { from, to });

//   if (!from || !to) {
//     console.warn('[FX] from ou to manquant, fallback 1');
//     return 1;
//   }

//   // Normalisation des devises (gère F CFA / FCFA / symboles)
//   const fromCur = normalizeCurrency(from);
//   const toCur = normalizeCurrency(to);

//   console.log('[FX] normalized currencies =', { fromCur, toCur });

//   // Même devise ou normalisation vide → taux 1
//   if (!fromCur || !toCur) {
//     console.warn('[FX] fromCur ou toCur vide après normalisation, fallback 1');
//     return 1;
//   }
//   if (fromCur === toCur) {
//     console.log('[FX] fromCur === toCur, rate = 1');
//     return 1;
//   }

//   // 1️⃣ Chercher un taux custom admin en DB
//   console.log('[FX] Searching custom admin rate in DB...', {
//     from: fromCur,
//     to: toCur,
//   });

//   const found = await ExchangeRate.findOne({
//     from: fromCur,
//     to: toCur,
//     active: true,
//   });

//   if (found && typeof found.rate === 'number') {
//     console.log('[FX] Using custom admin rate from DB', {
//       from: fromCur,
//       to: toCur,
//       rate: found.rate,
//       id: found._id,
//     });
//     return found.rate;
//   }

//   // 2️⃣ Si pas de FX_KEY → erreur explicite (sera catchée par le contrôleur)
//   if (!FX_API_KEY || FX_API_KEY === 'REPLACE_ME') {
//     console.warn(
//       "[FX] FX_API_KEY manquant : impossible d'appeler le provider externe"
//     );
//     throw new Error(
//       "Configuration FX manquante (FX_API_KEY). Merci de configurer l'API de taux de change."
//     );
//   }

//   // 3️⃣ Appel API externe (fallback)
//   try {
//     const url = `${FX_API_BASE_URL}/${FX_API_KEY}/latest/${fromCur}`;
//     console.log('[FX] Calling external FX provider =', {
//       url,
//       base: fromCur,
//       target: toCur,
//     });

//     const { data } = await axios.get(url);

//     console.log('[FX] External provider response meta =', {
//       result: data?.result,
//       base_code: data?.base_code,
//       hasConversionRates: !!data?.conversion_rates,
//       targetRate: data?.conversion_rates?.[toCur],
//     });

//     if (
//       !data ||
//       !data.conversion_rates ||
//       typeof data.conversion_rates[toCur] !== 'number'
//     ) {
//       console.error(
//         '[FX] Conversion rate missing in provider response for',
//         toCur
//       );
//       throw new Error('Taux de change introuvable via le provider externe.');
//     }

//     const rate = data.conversion_rates[toCur];
//     console.log('[FX] Using external provider rate', {
//       from: fromCur,
//       to: toCur,
//       rate,
//     });

//     return rate;
//   } catch (e) {
//     console.error(
//       '[FX] Erreur lors de la récupération du taux externe :',
//       e?.message
//     );
//     if (e?.response) {
//       console.error('[FX] Provider error response status =', e.response.status);
//       console.error('[FX] Provider error response data =', e.response.data);
//     }
//     // 4️⃣ Fallback ultra-sécurité pour ne pas casser les flux
//     console.warn('[FX] Fallback rate = 1 (sécurité)');
//     return 1;
//   }
// }

// module.exports = {
//   getExchangeRate,
// };



// File: src/services/exchangeRateService.js
'use strict';

const ExchangeRate = require('../models/ExchangeRate'); // adapte le chemin si besoin
const axios = require('axios');
const { normalizeCurrency } = require('../utils/currency');

const FX_API_BASE_URL =
  process.env.FX_API_BASE_URL || 'https://v6.exchangerate-api.com/v6';
const FX_API_KEY = process.env.FX_API_KEY || '';
// Devise de pivot pour le calcul croisé
const FX_CROSS = process.env.FX_CROSS || 'USD';

console.log('[FX] exchangeRateService initialisé', {
  FX_API_BASE_URL,
  hasKey: !!FX_API_KEY,
  FX_CROSS,
});

/**
 * Récupère le taux de change dynamique :
 * 1) Si from == to => 1
 * 2) Si un taux custom admin est en DB => ce taux
 * 3) Sinon API externe (exchangerate-api) via une devise de pivot (USD)
 * 4) Sinon erreur → "Taux de change indisponible"
 *
 * @param {string} from - Devise de départ (ex: EUR, F CFA, $...)
 * @param {string} to   - Devise d’arrivée (ex: XOF, USD...)
 * @returns {Promise<number>} - Taux (ex: 655.957)
 */
async function getExchangeRate(from, to) {
  console.log('[FX] getExchangeRate() called with raw values =', { from, to });

  if (!from || !to) {
    console.warn('[FX] from ou to manquant, retour 1');
    return 1;
  }

  // Normalisation des devises (gère F CFA / FCFA / symboles)
  const fromCur = normalizeCurrency(from);
  const toCur = normalizeCurrency(to);

  console.log('[FX] normalized currencies =', { fromCur, toCur });

  // Même devise ou normalisation vide → taux 1
  if (!fromCur || !toCur) {
    console.warn('[FX] fromCur ou toCur vide après normalisation, retour 1');
    return 1;
  }
  if (fromCur === toCur) {
    console.log('[FX] fromCur === toCur, rate = 1');
    return 1;
  }

  // 1️⃣ Chercher un taux custom admin en DB
  console.log('[FX] Searching custom admin rate in DB...', {
    from: fromCur,
    to: toCur,
  });

  const found = await ExchangeRate.findOne({
    from: fromCur,
    to: toCur,
    active: true,
  });

  if (found && typeof found.rate === 'number') {
    console.log('[FX] Using custom admin rate from DB', {
      from: fromCur,
      to: toCur,
      rate: found.rate,
      id: found._id,
    });
    return found.rate;
  }

  // 2️⃣ Si pas de FX_KEY → on lève une erreur (gérée par le contrôleur)
  if (!FX_API_KEY || FX_API_KEY === 'REPLACE_ME') {
    console.warn(
      "[FX] FX_API_KEY manquant : impossible d'appeler le provider externe"
    );
    throw new Error(
      "Configuration FX manquante (FX_API_KEY). Merci de configurer l'API de taux de change."
    );
  }

  // 3️⃣ Appel API externe avec devise de pivot (ex: USD)
  try {
    const url = `${FX_API_BASE_URL}/${FX_API_KEY}/latest/${FX_CROSS}`;
    console.log('[FX] Calling external FX provider =', {
      url,
      cross: FX_CROSS,
      fromCur,
      toCur,
    });

    const { data } = await axios.get(url);

    console.log('[FX] External provider response meta =', {
      result: data?.result,
      base_code: data?.base_code,
      hasConversionRates: !!data?.conversion_rates,
    });

    const rates = data?.conversion_rates || {};
    const rFrom = rates[fromCur];
    const rTo = rates[toCur];

    console.log('[FX] rates[fromCur], rates[toCur] =', { rFrom, rTo });

    if (typeof rFrom !== 'number' || typeof rTo !== 'number') {
      console.error(
        '[FX] Missing rate in provider response for pair',
        fromCur,
        '→',
        toCur
      );
      throw new Error('Taux de change introuvable via le provider externe.');
    }

    // Taux from → to via pivot : (to / cross) / (from / cross)
    const rate = rTo / rFrom;

    console.log('[FX] Computed cross rate =', {
      from: fromCur,
      to: toCur,
      rate,
    });

    return rate;
  } catch (e) {
    console.error(
      '[FX] Erreur lors de la récupération du taux externe :',
      e?.message
    );
    if (e?.response) {
      console.error('[FX] Provider error response status =', e.response.status);
      console.error('[FX] Provider error response data =', e.response.data);
    }
    // 4️⃣ On remonte une erreur : le contrôleur répondra 404
    throw new Error('Taux de change indisponible');
  }
}

module.exports = {
  getExchangeRate,
};
