require('dotenv').config();
const express = require('express');
const config = require('./config');
const stripe = require('stripe')(config.stripeKey);
const { stripeTransferController, stripeConfirmController } = require('./controllers/stripeController');

const app = express();
app.use(express.json());
app.post('/transactions/stripe', stripeTransferController);
app.post('/transactions/stripe/confirm', stripeConfirmController);

app.listen(4002, () => console.log('Service Stripe sur port 4002'));