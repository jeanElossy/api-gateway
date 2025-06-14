// src/config/index.js
require('dotenv').config();

module.exports = {
  port:      process.env.PORT,
  bankApi: {
    url:   process.env.BANK_API_URL,
    token: process.env.BANK_API_TOKEN
  }
};