// File: api-gateway/src/utils/referralUtils.js
'use strict';

const axios              = require('axios');
const { customAlphabet } = require('nanoid');
const logger             = require('../logger') || console;
const config             = require('../config');
const Transaction        = require('../models/Transaction');

// URL du backend principal (API Users / Wallet / Notifications)
// ➜ Doit pointer vers la base type : https://backend.paynoval.com/api/v1
const PRINCIPAL_URL = (config.principalUrl || process.env.PRINCIPAL_URL || '').replace(/\/+$/, '');

// Token interne partagé avec le backend principal
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

// Générateur nanoid à 3 chiffres (0-9)
const nanoid = customAlphabet('0123456789', 3);

// Listes des pays Europe/USA vs Afrique
const EUROPE_USA_COUNTRIES = ['Canada', 'USA', 'France', 'Belgique', 'Allemagne'];
const AFRICA_COUNTRIES     = ["Cote d'Ivoire", 'Mali', 'Burkina Faso', 'Senegal', 'Cameroun'];

/**
 * Nettoie le nom du pays : remplace entités HTML et supprime caractères non alphabétiques initiaux
 */
function cleanCountry(raw) {
  if (typeof raw !== 'string') return '';
  const step1 = raw.replace(/&#x27;/g, "'");
  return step1.replace(/^[^\p{L}]*/u, '');
}

/**
 * Normalise le nom du pays : retire accents et apostrophes spéciales
 */
function normalizeCountry(str) {
  if (typeof str !== 'string') return '';
  const noAccents = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return noAccents.replace(/’/g, "'").trim();
}

/**
 * Raccourci sur le modèle Transaction du Gateway
 * (toutes les transactions agrégées : paynoval, stripe, mobilemoney, etc.)
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
 * ➜ utilise désormais la route interne /users/:id/credit-internal
 *    sécurisée par x-internal-token
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
          // on peut aussi forward le JWT si tu veux le tracer côté backend
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
 * Envoi d'une notification via l'API principale (push + in-app)
 * ➜ ici on reste sur le JWT (Authorization) classique
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
 * Génère et assigne un referralCode après 2 transactions confirmées
 * ➜ se base sur les transactions du GATEWAY (tous providers)
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
      // En cas de conflit (code déjà existant), on retente
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
 * Logique :
 *  - Quand l'utilisateur a ≥ 2 transactions "confirmed" (dans le GATEWAY),
 *  - et qu'il n'a pas encore de code,
 *  - on lui génère un referralCode.
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
 * Processus de crédit du bonus de parrainage
 * ➜ Appelé sur la 1ʳᵉ transaction confirmée (dans le GATEWAY) de l'utilisateur
 *
 * @param {string} userId      - Filleul (sender / user connecté)
 * @param {Object} tx          - { amount, currency, country, provider, confirmedAt, ... }
 * @param {string} authToken   - JWT du user (Authorization: Bearer ...)
 */
async function processReferralBonusIfEligible(userId, tx, authToken) {
  if (!userId || !tx) return;

  logger.info(
    `[Referral] processReferralBonusIfEligible pour userId=${userId}, amount=${tx.amount}, currency=${tx.currency}`
  );

  // 1) Vérifier que c'est la 1ʳᵉ transaction confirmée pour ce user (dans le GATEWAY)
  const txCount = await TransactionModel().countDocuments({
    userId,
    status: 'confirmed',
  });

  if (txCount !== 1) {
    logger.info(
      `[Referral] txCount=${txCount} pour userId=${userId} (bonus uniquement à la 1ʳᵉ tx confirmée)`
    );
    return;
  }

  // 2) Récupérer filleul et parrain depuis le service principal
  const filleul = await fetchUserFromMain(userId, authToken);
  if (!filleul || !filleul.referredBy) {
    logger.info(
      `[Referral] Aucun parrain trouvé pour userId=${userId} (referredBy manquant).`
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

  // 3) Déterminer seuil et montants de bonus selon pays
  const paysF = normalizeCountry(cleanCountry(filleul.country));
  const paysP = normalizeCountry(cleanCountry(parrain.country));

  let seuil = 0,
    bonusF = 0,
    bonusP = 0,
    curF = '',
    curP = '';

  if (EUROPE_USA_COUNTRIES.includes(paysF) && EUROPE_USA_COUNTRIES.includes(paysP)) {
    seuil = 100;
    bonusF = 3;
    bonusP = 5;
    curF = curP = 'USD';
  } else if (AFRICA_COUNTRIES.includes(paysF) && AFRICA_COUNTRIES.includes(paysP)) {
    seuil = 20000;
    bonusF = 500;
    bonusP = 500;
    curF = curP = 'XOF';
  } else {
    if (EUROPE_USA_COUNTRIES.includes(paysF)) {
      seuil = 100;
      bonusF = 3;
      curF = 'USD';
    } else if (AFRICA_COUNTRIES.includes(paysF)) {
      seuil = 20000;
      bonusF = 500;
      curF = 'XOF';
    }

    if (EUROPE_USA_COUNTRIES.includes(paysP)) {
      bonusP = 5;
      curP = 'USD';
    } else if (AFRICA_COUNTRIES.includes(paysP)) {
      bonusP = 500;
      curP = 'XOF';
    }
  }

  const amountFloat = parseFloat(tx.amount);
  if (Number.isNaN(amountFloat) || amountFloat < seuil) {
    logger.info(
      `[Referral] Montant ${amountFloat} < seuil ${seuil}, aucun bonus appliqué.`
    );
    return;
  }

  // 4) Créditer les balances via le backend principal (source de vérité des soldes)
  try {
    if (bonusF > 0 && curF) {
      await creditBalanceInMain(
        userId,
        bonusF,
        curF,
        'Bonus de bienvenue (filleul)',
        authToken
      );
    }
    if (bonusP > 0 && curP) {
      await creditBalanceInMain(
        parrainId,
        bonusP,
        curP,
        `Bonus de parrainage pour ${filleul.fullName || filleul.email || userId}`,
        authToken
      );
    }
  } catch (err) {
    // On log mais on ne casse pas la transaction confirmée
    logger.error(
      '[Referral] Erreur lors du crédit de bonus parrainage:',
      err.message || err
    );
  }

  // 5) Envoyer notifications via l'API principale
  await sendNotificationToMain(
    parrainId,
    'Bonus parrain PayNoval crédité',
    `Vous avez reçu ${bonusP}${curP} grâce à l'activité de votre filleul.`,
    { type: 'referral_bonus', amount: bonusP, currency: curP },
    authToken
  );

  await sendNotificationToMain(
    userId,
    'Bonus de bienvenue PayNoval crédité',
    `Vous avez reçu ${bonusF}${curF} pour votre première transaction réussie.`,
    { type: 'referral_bonus', amount: bonusF, currency: curF },
    authToken
  );
}

module.exports = {
  checkAndGenerateReferralCodeInMain,
  processReferralBonusIfEligible,
};
