const axios = require('axios');
const config = require('./config');
const { bankApi } = config;

exports.bankTransferController = async (req, res) => {
  const { amount, accountNumber } = req.body;
  const response = await axios.post(process.env.BANK_API_URL + '/virements', { amount, accountNumber }, { headers: { Authorization: `Bearer ${process.env.BANK_API_TOKEN}` } });
  res.json(response.data);
};