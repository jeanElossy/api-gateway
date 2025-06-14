require('dotenv').config();
const express = require('express');
const { mobileMoneyController } = require('./controllers/mobileMoneyController');
const config = require('./config');
const { mmProviders, mmTokens } = config;

const app = express();
app.use(express.json());
app.post('/transactions/mobile-money', mobileMoneyController);
app.listen(4004, () => console.log('Service MobileMoney sur port 4004'));