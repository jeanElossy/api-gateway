// File: api-gateway/src/services/transactionNotificationService.js
'use strict';

const { sendEmail } = require('../utils/sendEmail');
const logger = require('../logger') || console;

const {
  initiatedSenderTemplate,
  initiatedReceiverTemplate,
  confirmedSenderTemplate,
  confirmedReceiverTemplate,
  cancelledSenderTemplate,
  cancelledReceiverTemplate,
} = require('../utils/transactionEmailTemplates');

/**
 * Payload attendu (api-paynoval OU Gateway interne) :
 *
 * {
 *   type: 'initiated' | 'confirmed' | 'cancelled',
 *   transaction: {
 *     id,
 *     reference,
 *     amount,
 *     currency,
 *     dateIso,        // ISO string
 *   },
 *   sender: {
 *     email,
 *     name,
 *   },
 *   receiver: {
 *     email,
 *     name,
 *   },
 *   reason?: string,        // pour cancelled
 *   links?: {
 *     sender?: string,          // lien "voir la transaction" (expéditeur)
 *     receiverConfirm?: string, // lien "valider la transaction" (destinataire)
 *   }
 * }
 */

async function notifyTransactionEvent(payload) {
  const { type, transaction, sender, receiver, reason, links = {} } = payload || {};

  if (!transaction || !sender || !receiver) {
    logger.warn('[Gateway][notifyTransactionEvent] payload incomplet, ignoré.', {
      hasTx: !!transaction,
      hasSender: !!sender,
      hasReceiver: !!receiver,
    });
    return;
  }

  const baseData = {
    transactionId: transaction.id,
    reference: transaction.reference || '',
    amount: transaction.amount,
    currency: transaction.currency,
    date: transaction.dateIso,
  };

  try {
    if (type === 'initiated') {
      // Expéditeur
      if (sender.email) {
        const htmlSender = initiatedSenderTemplate({
          ...baseData,
          name: sender.name || sender.email,
          senderEmail: sender.email,
          receiverEmail: receiver.email,
          confirmLinkWeb: links.sender || '',
        });
        await sendEmail({
          to: sender.email,
          subject: '✅ PayNoval — Votre transaction a été initiée',
          html: htmlSender,
        });
      }

      // Destinataire
      if (receiver.email) {
        const htmlReceiver = initiatedReceiverTemplate({
          ...baseData,
          name: receiver.name || receiver.email,
          senderEmail: sender.email,
          confirmLink: links.receiverConfirm || '',
        });
        await sendEmail({
          to: receiver.email,
          subject: '💸 PayNoval — Nouvelle transaction en attente de validation',
          html: htmlReceiver,
        });
      }
    } else if (type === 'confirmed') {
      // Expéditeur
      if (sender.email) {
        const htmlSender = confirmedSenderTemplate({
          ...baseData,
          name: sender.name || sender.email,
          receiverEmail: receiver.email,
        });
        await sendEmail({
          to: sender.email,
          subject: '✅ PayNoval — Transaction confirmée',
          html: htmlSender,
        });
      }

      // Destinataire
      if (receiver.email) {
        const htmlReceiver = confirmedReceiverTemplate({
          ...baseData,
          name: receiver.name || receiver.email,
        });
        await sendEmail({
          to: receiver.email,
          subject: '✅ PayNoval — Transaction reçue',
          html: htmlReceiver,
        });
      }
    } else if (type === 'cancelled') {
      // Expéditeur
      if (sender.email) {
        const htmlSender = cancelledSenderTemplate({
          ...baseData,
          name: sender.name || sender.email,
          reason: reason || '',
        });
        await sendEmail({
          to: sender.email,
          subject: '❌ PayNoval — Transaction annulée',
          html: htmlSender,
        });
      }

      // Destinataire
      if (receiver.email) {
        const htmlReceiver = cancelledReceiverTemplate({
          ...baseData,
          name: receiver.name || receiver.email,
          reason: reason || '',
        });
        await sendEmail({
          to: receiver.email,
          subject: '❌ PayNoval — Transaction annulée',
          html: htmlReceiver,
        });
      }
    } else {
      logger.warn(
        `[Gateway][notifyTransactionEvent] type inconnu "${type}", aucun email envoyé.`
      );
    }
  } catch (err) {
    logger.error(
      '[Gateway][notifyTransactionEvent] Erreur envoi emails transaction:',
      err.message || err
    );
  }
}

module.exports = {
  notifyTransactionEvent,
};
