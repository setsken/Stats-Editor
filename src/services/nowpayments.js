const axios = require('axios');

const NOWPAYMENTS_API_URL = process.env.NOWPAYMENTS_SANDBOX === 'true' 
  ? 'https://api-sandbox.nowpayments.io/v1'
  : 'https://api.nowpayments.io/v1';

const api = axios.create({
  baseURL: NOWPAYMENTS_API_URL,
  headers: {
    'x-api-key': process.env.NOWPAYMENTS_API_KEY,
    'Content-Type': 'application/json'
  }
});

// Plans configuration
const PLANS = {
  plus: {
    name: 'Plus',
    price: 30,
    modelLimit: 10,
    currency: 'USD'
  },
  pro: {
    name: 'Pro',
    price: 50,
    modelLimit: 50,
    currency: 'USD'
  }
};

// Get available cryptocurrencies
const getAvailableCurrencies = async () => {
  try {
    const response = await api.get('/currencies');
    return response.data.currencies;
  } catch (error) {
    console.error('NOWPayments get currencies error:', error.response?.data || error.message);
    throw error;
  }
};

// Get minimum payment amount for currency
const getMinimumAmount = async (currencyFrom, currencyTo = 'usd') => {
  try {
    const response = await api.get('/min-amount', {
      params: { currency_from: currencyFrom, currency_to: currencyTo }
    });
    return response.data.min_amount;
  } catch (error) {
    console.error('NOWPayments min amount error:', error.response?.data || error.message);
    throw error;
  }
};

// Get estimated price in crypto
const getEstimatedPrice = async (amount, currencyFrom, currencyTo) => {
  try {
    const response = await api.get('/estimate', {
      params: { 
        amount,
        currency_from: currencyFrom, 
        currency_to: currencyTo 
      }
    });
    return response.data;
  } catch (error) {
    console.error('NOWPayments estimate error:', error.response?.data || error.message);
    throw error;
  }
};

// Create payment
const createPayment = async ({ 
  priceAmount, 
  priceCurrency = 'usd', 
  payCurrency, 
  orderId, 
  orderDescription,
  ipnCallbackUrl,
  successUrl,
  cancelUrl
}) => {
  try {
    const payload = {
      price_amount: priceAmount,
      price_currency: priceCurrency,
      pay_currency: payCurrency,
      order_id: orderId,
      order_description: orderDescription,
      ipn_callback_url: ipnCallbackUrl,
      success_url: successUrl,
      cancel_url: cancelUrl,
      is_fixed_rate: true,
      is_fee_paid_by_user: false
    };

    const response = await api.post('/payment', payload);
    return response.data;
  } catch (error) {
    console.error('NOWPayments create payment error:', error.response?.data || error.message);
    throw error;
  }
};

// Create invoice (alternative to payment - user chooses crypto on NOWPayments page)
const createInvoice = async ({
  priceAmount,
  priceCurrency = 'usd',
  orderId,
  orderDescription,
  ipnCallbackUrl,
  successUrl,
  cancelUrl
}) => {
  try {
    const payload = {
      price_amount: priceAmount,
      price_currency: priceCurrency,
      order_id: orderId,
      order_description: orderDescription,
      ipn_callback_url: ipnCallbackUrl,
      success_url: successUrl,
      cancel_url: cancelUrl,
      is_fixed_rate: true,
      is_fee_paid_by_user: false
    };

    const response = await api.post('/invoice', payload);
    return response.data;
  } catch (error) {
    console.error('NOWPayments create invoice error:', error.response?.data || error.message);
    throw error;
  }
};

// Get payment status
const getPaymentStatus = async (paymentId) => {
  try {
    const response = await api.get(`/payment/${paymentId}`);
    return response.data;
  } catch (error) {
    console.error('NOWPayments get status error:', error.response?.data || error.message);
    throw error;
  }
};

// Verify IPN signature
const verifyIPNSignature = (payload, signature) => {
  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET);
  
  // Sort payload keys and create string
  const sortedPayload = Object.keys(payload)
    .sort()
    .reduce((acc, key) => {
      acc[key] = payload[key];
      return acc;
    }, {});
  
  const payloadString = JSON.stringify(sortedPayload);
  const calculatedSignature = hmac.update(payloadString).digest('hex');
  
  return calculatedSignature === signature;
};

// Payment status mapping
const PAYMENT_STATUSES = {
  waiting: 'pending',      // Waiting for payment
  confirming: 'pending',   // Payment detected, waiting confirmations
  confirmed: 'completed',  // Payment confirmed
  sending: 'completed',    // Sending to merchant
  partially_paid: 'partial', // Partially paid
  finished: 'completed',   // Payment finished
  failed: 'failed',        // Payment failed
  refunded: 'refunded',    // Payment refunded
  expired: 'expired'       // Payment expired
};

module.exports = {
  PLANS,
  getAvailableCurrencies,
  getMinimumAmount,
  getEstimatedPrice,
  createPayment,
  createInvoice,
  getPaymentStatus,
  verifyIPNSignature,
  PAYMENT_STATUSES
};
