// File: api-gateway/src/utils/referralUtils.js
'use strict';

const axios              = require('axios');
const { customAlphabet } = require('nanoid');
const logger             = require('../logger') || console;
const config             = require('../config');
const Transaction        = require('../models/Transaction');

// URL du backend principal (API Users / Wallet / Notifications)
const PRINCIPAL_URL = (config.principalUrl || process.env.PRINCIPAL_URL || '').replace(/\/+$/, '');

// Token interne partagé avec le backend principal
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

// Générateur nanoid à 3 chiffres (0-9)
const nanoid = customAlphabet('0123456789', 3);

// Listes de pays par région (normalisés en minuscule, sans accents)
const AMERICA_COUNTRIES = [
  'canada',
  'usa',
  'united states',
  'united states of america',
];

const EUROPE_COUNTRIES = [
  'france',
  'belgique',
  'belgium',
  'allemagne',
  'germany',
];

const AFRICA_COUNTRIES = [
  "cote d'ivoire",
  "cote d'ivoire",
  "cote d ivoire",
  'cote divoire',
  'cote divoire',
  'cote-d-ivoire',
  'mali',
  'burkina faso',
  'senegal',
  'senegal',
  'cameroun',
  'cameroon',
  'benin',
  'benin',
  'togo',
  'ghana',
];

// Seuils selon la région du FILLEUL (2 premiers transferts cumulés)
const THRESHOLDS_BY_REGION = {
  AMERICA: { currency: 'CAD', minTotal: 200 },
  EUROPE:  { currency: 'EUR', minTotal: 200 },
  AFRICA:  { currency: 'XOF', minTotal: 60000 },
};

// Bonus selon la région du PARRAIN (devise du parrain)
const BONUSES_BY_REGION = {
  AMERICA: {
    currency: 'CAD',
    parrain: 5,
    filleul: 3,
  },
  EUROPE: {
    currency: 'EUR',
    parrain: 4,
    filleul: 2,
  },
  AFRICA: {
    currency: 'XOF',
    parrain: 2000,
    filleul: 1000,
  },
};

/**
 * Nettoie le nom du pays : remplace entités HTML et supprime caractères non alphabétiques initiaux
 */
function cleanCountry(raw) {
  if (typeof raw !== 'string') return '';
  const step1 = raw.replace(/&#x27;/g, "'");
  return step1.replace(/^[^\p{L}]*/u, '');
}

/**
 * Normalise le nom du pays : retire accents, apostrophes spéciales, met en minuscule
 */
function normalizeCountry(str) {
  if (typeof str !== 'string') return '';
  const noAccents = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return noAccents.replace(/’/g, "'").trim().toLowerCase();
}

/**
 * Détermine la région (AMERICA / EUROPE / AFRICA) à partir d'un pays
 */
function getRegionFromCountry(countryRaw) {
  const normalized = normalizeCountry(cleanCountry(countryRaw));

  if (!normalized) return null;

  if (AMERICA_COUNTRIES.includes(normalized)) return 'AMERICA';
  if (EUROPE_COUNTRIES.includes(normalized))  return 'EUROPE';
  if (AFRICA_COUNTRIES.includes(normalized))  return 'AFRICA';

  return null;
}

/**
 * Raccourci sur le modèle Transaction du Gateway
 */
function TransactionModel() {
  return Transaction;
}

/**
 * Récupère un utilisateur depuis le service principal
 */
async function fetchUserFromMain(userId, authToken) {
  if (!PRINCIPAL_URL) {
    logger.error('[Referral][fetchUserFromMain] PRINCIPAL_URL manquant');
    return null;
  }

  const url = `${PRINCIPAL_URL}/users/${userId}`;
  try {
    const res = await axios.get(url, {
      headers: authToken ? { Authorization: authToken } : {},
    });
    return res.data.data || null;
  } catch (err) {
    if (err.response?.status === 404) {
      logger.warn(`[Referral][fetchUserFromMain] utilisateur ${userId} introuvable`);
      return null;
    }
    logger.error(`[Referral][fetchUserFromMain] erreur GET ${url}:`, err.message);
    throw err;
  }
}

/**
 * Patch un utilisateur dans le service principal
 */
async function patchUserInMain(userId, updates, authToken) {
  if (!PRINCIPAL_URL) {
    logger.error('[Referral][patchUserInMain] PRINCIPAL_URL manquant');
    return;
  }

  const url = `${PRINCIPAL_URL}/users/${userId}`;
  try {
    await axios.patch(url, updates, {
      headers: authToken ? { Authorization: authToken } : {},
    });
  } catch (err) {
    logger.error(`[Referral][patchUserInMain] erreur PATCH ${url}:`, err.message);
    throw err;
  }
}


/**
 * Crédite la balance dans le service principal
 * ➜ utilise la route interne /users/:id/credit-internal
 */
async function creditBalanceInMain(userId, amount, currency, description, authToken) {
  if (!PRINCIPAL_URL) {
    logger.error('[Referral][creditBalanceInMain] PRINCIPAL_URL manquant');
    return;
  }
  if (!INTERNAL_TOKEN) {
    logger.error('[Referral][creditBalanceInMain] INTERNAL_TOKEN manquant');
    return;
  }

  const url = `${PRINCIPAL_URL}/users/${userId}/credit-internal`;
  try {
    await axios.post(
      url,
      { amount, currency, description },
      {
        headers: {
          'x-internal-token': INTERNAL_TOKEN,
          ...(authToken ? { Authorization: authToken } : {}),
        },
      }
    );
  } catch (err) {
    logger.error(`[Referral][creditBalanceInMain] erreur POST ${url}:`, err.message);
    throw err;
  }
}

/**
 * Envoi d'une notification via l'API principale
 */
async function sendNotificationToMain(userId, title, message, data = {}, authToken) {
  if (!PRINCIPAL_URL) {
    logger.error('[Referral][sendNotificationToMain] PRINCIPAL_URL manquant');
    return;
  }

  const url = `${PRINCIPAL_URL}/notifications`;
  try {
    await axios.post(
      url,
      { recipient: userId, title, message, data },
      { headers: authToken ? { Authorization: authToken } : {} }
    );
    logger.info(`[Referral] Notification envoyée à ${userId}`);
  } catch (err) {
    logger.error(`[Referral][sendNotificationToMain] erreur POST ${url}:`, err.message);
  }
}

/**
 * Génère et assigne un referralCode après ≥ 2 transactions confirmées
 */
async function generateAndAssignReferralInMain(userMain, senderId, authToken) {
  const firstName = (userMain.fullName || '').split(' ')[0].toUpperCase() || 'USER';

  for (let attempt = 0; attempt < 5; attempt++) {
    const newCode = `${firstName}_${nanoid()}`;
    try {
      await patchUserInMain(
        senderId,
        { referralCode: newCode, hasGeneratedReferral: true },
        authToken
      );
      logger.info(
        `[Referral] Code "${newCode}" assigné pour ${senderId} (tentative ${attempt + 1})`
      );
      return;
    } catch (err) {
      if (err.response?.status === 409) {
        logger.warn(
          `[Referral] Conflit sur le code "${newCode}", nouvelle tentative…`
        );
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Impossible de générer un referralCode unique pour ${senderId}`);
}

/**
 * Vérifie et génère le referralCode dans le service principal
 * - Quand l'utilisateur a ≥ 2 transactions "confirmed" (Gateway),
 * - et qu'il n'a pas encore de code.
 */
async function checkAndGenerateReferralCodeInMain(senderId, authToken) {
  if (!senderId) return;

  const count = await TransactionModel().countDocuments({
    userId: senderId,
    status: 'confirmed',
  });

  logger.info(
    `[Referral] Nombre de transactions confirmées (gateway) pour ${senderId}: ${count}`
  );

  if (count < 2) return;

  const userMain = await fetchUserFromMain(senderId, authToken);
  if (!userMain) return;
  if (userMain.hasGeneratedReferral || userMain.referralCode) return;

  await generateAndAssignReferralInMain(userMain, senderId, authToken);
}

/**
 * Calcule si les 2 premières transactions confirmées du filleul atteignent le seuil
 */
async function getFirstTwoConfirmedTotal(userId) {
  const txs = await TransactionModel()
    .find({ userId, status: 'confirmed' })
    .sort({ confirmedAt: 1, createdAt: 1 })
    .limit(2)
    .lean();

  if (!txs || txs.length < 2) {
    return { count: txs.length || 0, total: 0 };
  }

  const total = txs.reduce((sum, tx) => {
    const val = parseFloat(tx.amount);
    if (Number.isNaN(val)) return sum;
    return sum + val;
  }, 0);

  return { count: txs.length, total };
}

/**
 * Processus de crédit du bonus de parrainage
 *
 * ➜ Appelé sur chaque transaction CONFIRMÉE (Gateway) du FILLEUL.
 *    La logique va :
 *      - vérifier qu'il y a bien 2 transactions confirmées,
 *      - vérifier que la somme des 2 premières atteint le seuil
 *        selon la région du FILLEUL,
 *      - créditer PARRAIN + FILLEUL selon la région du PARRAIN (bonus & devise),
 *      - marquer le bonus comme déjà crédité côté backend principal.
 *
 * @param {string} userId    - Filleul (sender / user connecté)
 * @param {string} authToken - JWT du user (Authorization: Bearer ...)
 */
async function processReferralBonusIfEligible(userId, authToken) {
  if (!userId || !authToken) return;

  logger.info(`[Referral] processReferralBonusIfEligible pour userId=${userId}`);

  // 1) Récupérer filleul depuis le service principal
  const filleul = await fetchUserFromMain(userId, authToken);
  if (!filleul) {
    logger.info(`[Referral] Filleul ${userId} introuvable dans le backend principal.`);
    return;
  }

  if (!filleul.referredBy) {
    logger.info(
      `[Referral] Aucun parrain trouvé pour userId=${userId} (referredBy manquant).`
    );
    return;
  }

  // Si bonus déjà crédité, on ne refait rien (idempotence)
  if (filleul.referralBonusCredited) {
    logger.info(
      `[Referral] Bonus déjà crédité pour userId=${userId}, on ne refait rien.`
    );
    return;
  }

  const parrainId = filleul.referredBy;
  const parrain   = await fetchUserFromMain(parrainId, authToken);
  if (!parrain) {
    logger.warn(
      `[Referral] Utilisateur parrain ${parrainId} introuvable, bonus ignoré.`
    );
    return;
  }

  // 2) Régions filleul + parrain
  const paysF = normalizeCountry(cleanCountry(filleul.country));
  const paysP = normalizeCountry(cleanCountry(parrain.country));

  const regionF = getRegionFromCountry(paysF);
  const regionP = getRegionFromCountry(paysP);

  if (!regionF) {
    logger.warn(
      `[Referral] Région du filleul inconnue (country="${filleul.country}"), bonus ignoré.`
    );
    return;
  }
  if (!regionP) {
    logger.warn(
      `[Referral] Région du parrain inconnue (country="${parrain.country}"), bonus ignoré.`
    );
    return;
  }

  const seuilCfg  = THRESHOLDS_BY_REGION[regionF];
  const bonusCfg  = BONUSES_BY_REGION[regionP];

  if (!seuilCfg || !bonusCfg) {
    logger.warn(
      `[Referral] Configuration seuil/bonus manquante pour regions F=${regionF}, P=${regionP}`
    );
    return;
  }

  // 3) Récupérer les 2 premières tx confirmées et leur somme
  const { count, total } = await getFirstTwoConfirmedTotal(userId);

  logger.info(
    `[Referral] userId=${userId}, txConfirmedCount=${count}, totalFirstTwo=${total}, seuil=${seuilCfg.minTotal}${seuilCfg.currency}`
  );

  if (count < 2) {
    // Le programme exige les 2 premières transactions confirmées
    logger.info(
      `[Referral] Moins de 2 transactions confirmées pour userId=${userId}, bonus non déclenché.`
    );
    return;
  }

  if (Number.isNaN(total) || total < seuilCfg.minTotal) {
    logger.info(
      `[Referral] Total des 2 premières tx (${total}) < seuil (${seuilCfg.minTotal}), aucun bonus.`
    );
    return;
  }

  // 4) Créditer les balances via le backend principal (source de vérité des soldes)
  const { currency: bonusCurrency, parrain: bonusParrain, filleul: bonusFilleul } = bonusCfg;

  try {
    if (bonusFilleul > 0) {
      await creditBalanceInMain(
        userId,
        bonusFilleul,
        bonusCurrency,
        'Bonus de bienvenue (filleul - programme de parrainage PayNoval)',
        authToken
      );
    }

    if (bonusParrain > 0) {
      await creditBalanceInMain(
        parrainId,
        bonusParrain,
        bonusCurrency,
        `Bonus de parrainage pour ${filleul.fullName || filleul.email || userId}`,
        authToken
      );
    }

    // 5) Marquer le bonus comme crédité côté backend principal (côté filleul)
    await patchUserInMain(
      userId,
      {
        referralBonusCredited: true,
        referralBonusCurrency: bonusCurrency,
        referralBonusParrainAmount: bonusParrain,
        referralBonusFilleulAmount: bonusFilleul,
        referralBonusCreditedAt: new Date().toISOString(),
      },
      authToken
    );
  } catch (err) {
    // On log mais on ne casse pas la transaction confirmée globale
    logger.error(
      '[Referral] Erreur lors du crédit de bonus parrainage:',
      err.message || err
    );
    return;
  }

  // 6) Envoyer notifications via l'API principale
  await sendNotificationToMain(
    parrainId,
    'Bonus parrain PayNoval crédité',
    `Vous avez reçu ${bonusParrain} ${bonusCurrency} grâce à l’activité de votre filleul.`,
    {
      type: 'referral_bonus',
      role: 'parrain',
      amount: bonusParrain,
      currency: bonusCurrency,
      childUserId: userId,
    },
    authToken
  );

  await sendNotificationToMain(
    userId,
    'Bonus de bienvenue PayNoval crédité',
    `Vous avez reçu ${bonusFilleul} ${bonusCurrency} grâce à vos premiers transferts sur PayNoval.`,
    {
      type: 'referral_bonus',
      role: 'filleul',
      amount: bonusFilleul,
      currency: bonusCurrency,
      parentUserId: parrainId,
    },
    authToken
  );

  logger.info(
    `[Referral] Bonus parrainage crédité (parrain=${parrainId}, filleul=${userId}, ${bonusParrain}/${bonusFilleul} ${bonusCurrency})`
  );
}

module.exports = {
  checkAndGenerateReferralCodeInMain,
  processReferralBonusIfEligible,
};
