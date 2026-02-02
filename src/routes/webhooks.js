const express = require('express');
const crypto = require('crypto');
const { query, getOne } = require('../config/database');
const nowpayments = require('../services/nowpayments');

const router = express.Router();

// NOWPayments IPN Webhook
router.post('/nowpayments', async (req, res) => {
  try {
    // Parse body (it comes as raw buffer)
    const payload = JSON.parse(req.body.toString());

    console.log('NOWPayments webhook received:', payload);

    // Verify signature
    const signature = req.headers['x-nowpayments-sig'];
    if (signature && process.env.NOWPAYMENTS_IPN_SECRET) {
      const isValid = nowpayments.verifyIPNSignature(payload, signature);
      if (!isValid) {
        console.error('Invalid NOWPayments webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const {
      payment_id,
      payment_status,
      order_id,
      price_amount,
      actually_paid,
      pay_currency,
      outcome_amount
    } = payload;

    // Find payment in our DB
    const payment = await getOne(`
      SELECT p.*, u.email
      FROM payments p
      JOIN users u ON u.id = p.user_id
      WHERE p.provider_payment_id = $1 OR p.metadata->>'orderId' LIKE $2
    `, [payment_id, `%${order_id}%`]);

    if (!payment) {
      console.error('Payment not found for webhook:', payment_id, order_id);
      return res.status(200).json({ received: true }); // Return 200 to stop retries
    }

    // Map status
    let mappedStatus = nowpayments.PAYMENT_STATUSES[payment_status] || 'pending';

    // Check if this payment was already processed (to prevent duplicate processing)
    if (payment.status === 'completed' && mappedStatus === 'completed') {
      console.log(`Payment ${payment_id} already processed, skipping`);
      return res.status(200).json({ received: true, message: 'Already processed' });
    }

    // Get plan config to check price
    const planConfig = nowpayments.PLANS[payment.plan];
    const requiredPrice = planConfig ? planConfig.price : 0;

    // For partially_paid, check if actually_paid >= 98% of subscription price
    if (payment_status === 'partially_paid') {
      const paidAmount = parseFloat(actually_paid) || 0;
      const paidPercentage = requiredPrice > 0 ? (paidAmount / requiredPrice) * 100 : 0;
      
      console.log(`Partial payment check: actually_paid=${paidAmount} USDT, required=${requiredPrice} USD, percentage=${paidPercentage.toFixed(2)}%`);
      
      if (paidPercentage >= 98) {
        console.log(`Partial payment ${payment_id} ACCEPTED (${paidPercentage.toFixed(2)}% >= 98%)`);
        mappedStatus = 'completed';
      } else {
        console.log(`Partial payment ${payment_id} REJECTED (${paidPercentage.toFixed(2)}% < 98%)`);
        mappedStatus = 'partial';
      }
    }

    // Update payment record
    await query(`
      UPDATE payments
      SET status = $1,
          crypto_amount = $2,
          crypto_currency = $3,
          updated_at = NOW()
      WHERE id = $4
    `, [mappedStatus, actually_paid, pay_currency?.toUpperCase(), payment.id]);

    // If payment completed, activate subscription
    if (mappedStatus === 'completed') {
      console.log(`Payment ${payment_id} completed, activating subscription for user ${payment.user_id}`);

      // Plan config already loaded above
      if (!planConfig) {
        console.error('Invalid plan in payment:', payment.plan);
        return res.status(200).json({ received: true });
      }

      await query(`
        UPDATE users SET trial_used = true WHERE id = $1
      `, [payment.user_id]);

      // Check if user has existing subscription
      const existingSub = await getOne(
        'SELECT id, status, expires_at FROM subscriptions WHERE user_id = $1',
        [payment.user_id]
      );

      const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // +30 days

      if (existingSub) {
        // Update existing subscription
        const currentExpiry = new Date(existingSub.expires_at);
        const now = new Date();
        const finalExpiry = (existingSub.status === 'active' && currentExpiry > now)
          ? new Date(currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000)
          : newExpiry;

        await query(`
          UPDATE subscriptions SET plan = $1, model_limit = $2, status = 'active',
            payment_provider = 'nowpayments', payment_id = $3,
            starts_at = NOW(), expires_at = $4, updated_at = NOW()
          WHERE id = $5
        `, [payment.plan, planConfig.modelLimit, payment_id, finalExpiry, existingSub.id]);

        if (existingSub.status !== 'active' || currentExpiry <= now) {
          await query(`DELETE FROM user_models WHERE user_id = $1`, [payment.user_id]);
          console.log(`Cleared models for user ${payment.user_id} (new period)`);
        }
        console.log(`Updated subscription for user ${payment.user_id}`);
      } else {
        // Create NEW subscription record
        await query(`
          INSERT INTO subscriptions (user_id, plan, model_limit, status, payment_provider, payment_id, starts_at, expires_at, created_at, updated_at)
          VALUES ($1, $2, $3, 'active', 'nowpayments', $4, NOW(), $5, NOW(), NOW())
        `, [payment.user_id, payment.plan, planConfig.modelLimit, payment_id, newExpiry]);

        await query(`DELETE FROM user_models WHERE user_id = $1`, [payment.user_id]);
        console.log(`Created new subscription for user ${payment.user_id}`);
      }

      console.log(`Subscription activated: ${payment.plan} for user ${payment.user_id}`);
    }

    res.status(200).json({ received: true });

  } catch (error) {
    console.error('NOWPayments webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Stripe webhook (for later)
router.post('/stripe', async (req, res) => {
  // TODO: Implement Stripe webhook when needed
  res.status(200).json({ received: true, message: 'Stripe webhooks not yet implemented' });
});

module.exports = router;
