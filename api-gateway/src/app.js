const express = require('express');
const paymentRoutes = require('../routes/payment');
const { authMiddleware } = require('./middlewares/auth');
const { rateLimiter } = require('./middlewares/rateLimit');
const { loggerMiddleware } = require('./middlewares/logger');

const app = express();

app.use(express.json());
app.use(loggerMiddleware);
app.use(rateLimiter);
app.use(authMiddleware);

app.use('/api/pay', paymentRoutes);

module.exports = app;
