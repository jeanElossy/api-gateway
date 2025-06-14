require('dotenv').config();
const express = require('express');
const { bankTransferController } = require('./controllers/bankController');
const config = require('./config');
const { bankApi } = config;

const app = express();
app.use(express.json());
app.post('/transactions/bank', bankTransferController);
app.listen(4003, () => console.log('Service Banque sur port 4003'));