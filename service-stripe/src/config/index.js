// src/config/index.js
require('dotenv').config();

module.exports = {
  port:        process.env.PORT,
  stripeKey:   process.env.STRIPE_SECRET_KEY
};