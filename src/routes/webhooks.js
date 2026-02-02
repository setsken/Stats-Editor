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

      // Deactivate any existing active subscriptions (except trial)
      await query(`
        UPDATE subscriptions 
        SET status = 'replaced', updated_at = NOW()
        WHERE user_id = $1 AND status = 'active' AND plan != 'trial'
      `, [payment.user_id]);

      // Also mark trial as used
      await query(`
        UPDATE subscriptions 
        SET status = 'upgraded', updated_at = NOW()
        WHERE user_id = $1 AND plan = 'trial' AND status = 'active'
      `, [payment.user_id]);

      await query(`
        UPDATE users SET trial_used = true WHERE id = $1
      `, [payment.user_id]);

      // Create new subscription (30 days)
      await query(`
        INSERT INTO subscriptions (
          user_id, plan, model_limit, status, payment_provider, payment_id, 
          starts_at, expires_at
        ) VALUES ($1, $2, $3, 'active', 'nowpayments', $4, NOW(), NOW() + INTERVAL '30 days')
      `, [payment.user_id, payment.plan, planConfig.modelLimit, payment_id]);

      // Clear user's models for new subscription period
      await query(`DELETE FROM user_models WHERE user_id = $1`, [payment.user_id]);
      console.log(`Cleared models for user ${payment.user_id} (new subscription period)`);

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
