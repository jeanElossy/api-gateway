const axios = require('axios');
const config = require('./config');
const { mmProviders, mmTokens } = config;

exports.mobileMoneyController = async (req, res) => {
  const { amount, phoneNumber, operator } = req.body;
  const apiUrl = process.env.MM_API_URL[operator];
  const token  = process.env.MM_API_TOKEN[operator];
  const response = await axios.post(`${apiUrl}/payments`, { amount, phoneNumber }, { headers: { Authorization: `Bearer ${token}` } });
  res.json(response.data);
};