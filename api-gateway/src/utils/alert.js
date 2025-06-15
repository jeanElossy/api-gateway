const axios = require('axios');
const nodemailer = require('nodemailer');
const logger = require('../logger');

const ALERT_EMAIL = process.env.FRAUD_ALERT_EMAIL;
const ALERT_WEBHOOK_URL = process.env.FRAUD_ALERT_WEBHOOK_URL;

// Slack/Teams/webhook, etc.
async function sendFraudAlert(payload) {
  logger.error('[AML-FRAUD-ALERT]', payload);

  // Envoi Webhook (Slack/Teams/SIEM/Discord…)
  if (ALERT_WEBHOOK_URL) {
    try {
      await axios.post(ALERT_WEBHOOK_URL, payload);
    } catch (e) {
      logger.error('[AML-FRAUD-ALERT][webhook] Fail', e);
    }
  }

  // Envoi Email (admin/compliance)
  if (ALERT_EMAIL) {
    try {
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
      await transport.sendMail({
        from: `AML System <${process.env.SMTP_USER}>`,
        to: ALERT_EMAIL,
        subject: `[PayNoval AML ALERT] Transaction Suspect`,
        text: JSON.stringify(payload, null, 2),
      });
    } catch (e) {
      logger.error('[AML-FRAUD-ALERT][email] Fail', e);
    }
  }
}

module.exports = { sendFraudAlert };
