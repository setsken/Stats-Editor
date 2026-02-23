# NOWPayments Payment Lifetime Update

## Problem
Some payment methods only have 5 minutes lifetime which is not enough for users to complete payment.

## Solution
Add `lifetime: 60` parameter (60 minutes) to all payment creation requests.

## Files to Update

### 1. src/services/nowpayments.js

#### In `createPayment` function (around line 80):

```javascript
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
  is_fee_paid_by_user: false,
  lifetime: 60  // <-- ADD THIS LINE: Payment valid for 60 minutes
};
```

#### In `createInvoice` function (around line 115):

```javascript
const payload = {
  price_amount: priceAmount,
  price_currency: priceCurrency,
  order_id: orderId,
  order_description: orderDescription,
  ipn_callback_url: ipnCallbackUrl,
  success_url: successUrl,
  cancel_url: cancelUrl,
  is_fixed_rate: true,
  is_fee_paid_by_user: false,
  lifetime: 60  // <-- ADD THIS LINE: Payment valid for 60 minutes
};
```

## NOWPayments API Documentation
- `lifetime` parameter: Payment expiration time in minutes (integer, min 10, max 2880 = 48 hours)
- If not specified, NOWPayments uses their default which varies by payment method

## Recommendation
60 minutes (1 hour) gives users plenty of time to:
- Check their crypto wallet
- Transfer funds from exchange
- Wait for blockchain confirmations
