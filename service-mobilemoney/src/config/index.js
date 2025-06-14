// src/config/index.js
require('dotenv').config();

module.exports = {
  port: process.env.PORT,
  mmProviders: JSON.parse(process.env.MM_API_URL || '{}'),
  mmTokens:    JSON.parse(process.env.MM_API_TOKEN || '{}')
};