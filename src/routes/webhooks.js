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
    const mappedStatus = nowpayments.PAYMENT_STATUSES[payment_status] || 'pending';

    // Check if this payment was already processed (to prevent duplicate processing)
    if (payment.status === 'completed' && mappedStatus === 'completed') {
      console.log(`Payment ${payment_id} already processed, skipping`);
      return res.status(200).json({ received: true, message: 'Already processed' });
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

      // Get plan config
      const planConfig = nowpayments.PLANS[payment.plan];
      if (!planConfig) {
        console.error('Invalid plan in payment:', payment.plan);
        return res.status(200).json({ received: true });
      }

      await query(`
        UPDATE users SET trial_used = true WHERE id = $1
      `, [payment.user_id]);

      // Use UPSERT to ensure only ONE subscription record per user
      // This prevents race conditions from duplicate webhooks
      const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // +30 days from now
      
      const result = await query(`
        INSERT INTO subscriptions (
          user_id, plan, model_limit, status, payment_provider, payment_id, 
          starts_at, expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 'active', 'nowpayments', $4, NOW(), $5, NOW(), NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          plan = EXCLUDED.plan,
          model_limit = EXCLUDED.model_limit,
          status = 'active',
          payment_provider = 'nowpayments',
          payment_id = EXCLUDED.payment_id,
          starts_at = NOW(),
          expires_at = CASE 
            WHEN subscriptions.status = 'active' AND subscriptions.expires_at > NOW() 
            THEN subscriptions.expires_at + INTERVAL '30 days'
            ELSE EXCLUDED.expires_at
          END,
          updated_at = NOW()
        RETURNING (xmax = 0) as is_insert
      `, [payment.user_id, payment.plan, planConfig.modelLimit, payment_id, newExpiry]);

      const wasInsert = result.rows[0]?.is_insert;
      
      // Clear models only on new subscription (not extension)
      // Check if previous was not active
      if (wasInsert) {
        await query(`DELETE FROM user_models WHERE user_id = $1`, [payment.user_id]);
        console.log(`Cleared models for user ${payment.user_id} (first subscription)`);
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
