const Stripe = require('stripe');
const config = require('./config');
const stripe = require('stripe')(config.stripeKey);

exports.stripeTransferController = async (req, res) => {
  const { amount, paymentMethodId } = req.body;
  const paymentIntent = await stripe.paymentIntents.create({ amount, currency: 'eur', payment_method: paymentMethodId, confirm: true });
  res.json(paymentIntent);
};

exports.stripeConfirmController = async (req, res) => {
  // Stripe confirmation webhook ou endpoint
  res.json({ success: true });
};