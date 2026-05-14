const express = require('express');
const { query, getOne } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const nowpayments = require('../services/nowpayments');

const router = express.Router();

// Valid product identifiers for the multi-product subscription model.
const VALID_PRODUCTS = ['stats_editor', 'profile_stats'];

// Get current subscription status.
// Accepts optional ?product=stats_editor|profile_stats.
// - omitted  -> legacy behaviour: latest subscription for the user (any product), for old extension clients.
// - stats_editor -> only product='stats_editor' rows
// - profile_stats -> own profile_stats subscription, or fall back to active stats_editor 'pro' (grants Profile Stats)
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const requestedProduct = typeof req.query.product === 'string' ? req.query.product : null;
    if (requestedProduct && !VALID_PRODUCTS.includes(requestedProduct)) {
      return res.status(400).json({ error: 'Invalid product. Use "stats_editor" or "profile_stats".' });
    }

    let subscription = null;
    let grantedVia = null;

    if (!requestedProduct) {
      // Legacy path: latest sub for the user, regardless of product.
      subscription = await getOne(`
        SELECT
          s.id, s.plan, s.product, s.model_limit, s.status, s.payment_provider,
          s.starts_at, s.expires_at,
          CASE WHEN s.expires_at > NOW() AND s.status = 'active' THEN true ELSE false END as is_active,
          EXTRACT(DAY FROM s.expires_at - NOW()) as days_remaining
        FROM subscriptions s
        WHERE s.user_id = $1
        ORDER BY s.expires_at DESC
        LIMIT 1
      `, [req.user.id]);
    } else {
      // Product-specific path: own subscription for the requested product first.
      subscription = await getOne(`
        SELECT
          s.id, s.plan, s.product, s.model_limit, s.status, s.payment_provider,
          s.starts_at, s.expires_at,
          CASE WHEN s.expires_at > NOW() AND s.status = 'active' THEN true ELSE false END as is_active,
          EXTRACT(DAY FROM s.expires_at - NOW()) as days_remaining
        FROM subscriptions s
        WHERE s.user_id = $1 AND s.product = $2
        ORDER BY s.expires_at DESC
        LIMIT 1
      `, [req.user.id, requestedProduct]);

      // Fallback: requesting Profile Stats but no own sub -> active Stats Editor Pro grants access.
      if ((!subscription || !subscription.is_active) && requestedProduct === 'profile_stats') {
        const proSub = await getOne(`
          SELECT
            s.id, s.plan, s.product, s.model_limit, s.status, s.payment_provider,
            s.starts_at, s.expires_at,
            CASE WHEN s.expires_at > NOW() AND s.status = 'active' THEN true ELSE false END as is_active,
            EXTRACT(DAY FROM s.expires_at - NOW()) as days_remaining
          FROM subscriptions s
          WHERE s.user_id = $1
            AND s.product = 'stats_editor'
            AND s.plan = 'pro'
            AND s.status = 'active'
            AND s.expires_at > NOW()
          ORDER BY s.expires_at DESC
          LIMIT 1
        `, [req.user.id]);

        if (proSub) {
          subscription = proSub;
          grantedVia = 'stats_editor_pro';
        }
      }
    }

    // Get model count (kept on Stats Editor backend for backward compat; Profile Stats will own this later).
    const modelCount = await getOne(
      'SELECT COUNT(*) as count FROM user_models WHERE user_id = $1',
      [req.user.id]
    );

    if (!subscription) {
      return res.json({
        hasSubscription: false,
        subscription: null,
        product: requestedProduct || null,
        usage: { modelCount: parseInt(modelCount.count), modelLimit: 0 }
      });
    }

    res.json({
      hasSubscription: true,
      product: requestedProduct || subscription.product || 'stats_editor',
      grantedVia, // 'stats_editor_pro' when Profile Stats access comes from Pro plan, otherwise null
      subscription: {
        id: subscription.id,
        plan: subscription.plan,
        product: subscription.product || 'stats_editor',
        planName: subscription.plan === 'trial' ? 'Trial' :
                  subscription.plan === 'plus' ? 'Plus ($30/mo)' :
                  subscription.plan === 'pro' ? 'Pro ($50/mo)' :
                  subscription.plan === 'profile_stats' ? 'Profile Stats ($15/mo)' :
                  subscription.plan,
        modelLimit: subscription.model_limit, // null = unlimited
        status: subscription.status,
        isActive: subscription.is_active,
        paymentProvider: subscription.payment_provider,
        startsAt: subscription.starts_at,
        expiresAt: subscription.expires_at,
        daysRemaining: Math.max(0, Math.floor(subscription.days_remaining))
      },
      usage: {
        modelCount: parseInt(modelCount.count),
        modelLimit: subscription.model_limit
      }
    });

  } catch (error) {
    console.error('Get subscription status error:', error);
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

// Get available plans (optionally scoped by ?product=stats_editor|profile_stats)
router.get('/plans', async (req, res) => {
  const product = typeof req.query.product === 'string' ? req.query.product : null;

  const all = [
    {
      id: 'plus',
      product: 'stats_editor',
      name: 'Plus',
      price: 30,
      currency: 'USD',
      modelLimit: 10,
      features: [
        'Up to 10 models',
        'All plugin features',
        'Fan history tracking',
        'Priority support'
      ]
    },
    {
      id: 'pro',
      product: 'stats_editor',
      name: 'Pro',
      price: 50,
      currency: 'USD',
      modelLimit: 50,
      features: [
        'Up to 50 models',
        'All plugin features',
        'Fan history tracking',
        'Priority support',
        'Profile Stats included for free',
        'Early access to new features'
      ]
    },
    {
      id: 'profile_stats',
      product: 'profile_stats',
      name: 'Profile Stats',
      price: 15,
      currency: 'USD',
      modelLimit: null,
      features: [
        'Badge on every OF profile (score, grade, percentile)',
        'AI verdict on profile quality',
        'Fan trend chart',
        'Personal notes and tags (cloud sync)',
        'Smart alerts on score changes'
      ]
    }
  ];

  const plans = product ? all.filter(p => p.product === product) : all;
  res.json({ plans });
});

// Get available cryptocurrencies/networks for payment
router.get('/crypto-currencies', async (req, res) => {
  // Return USDT networks with exact prices (no fees for user)
  res.json({ 
    currencies: [
      { id: 'usdttrc20', name: 'USDT', network: 'TRC20 (Tron)', symbol: 'USDT' },
      { id: 'usdtbsc', name: 'USDT', network: 'BEP20 (BSC)', symbol: 'USDT' },
      { id: 'usdtsol', name: 'USDT', network: 'Solana', symbol: 'USDT' },
      { id: 'usdterc20', name: 'USDT', network: 'ERC20 (Ethereum)', symbol: 'USDT' },
      { id: 'usdtton', name: 'USDT', network: 'TON', symbol: 'USDT' }
    ]
  });
});

// Get price estimate in crypto
router.get('/estimate/:plan/:currency', authenticateToken, async (req, res) => {
  try {
    const { plan, currency } = req.params;
    
    const planConfig = nowpayments.PLANS[plan];
    if (!planConfig) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const estimate = await nowpayments.getEstimatedPrice(
      planConfig.price,
      'usd',
      currency.toLowerCase()
    );

    res.json({
      plan: plan,
      priceUSD: planConfig.price,
      cryptoCurrency: currency.toUpperCase(),
      estimatedAmount: estimate.estimated_amount,
      rate: estimate.rate_id
    });

  } catch (error) {
    console.error('Get estimate error:', error);
    res.status(500).json({ error: 'Failed to get price estimate' });
  }
});

// Create payment for subscription
router.post('/create-payment', authenticateToken, async (req, res) => {
  try {
    const { plan, currency } = req.body;

    // Validate plan
    const planConfig = nowpayments.PLANS[plan];
    if (!planConfig) {
      return res.status(400).json({ error: 'Invalid plan. Use "plus", "pro" or "profile_stats"' });
    }

    // Each product has its own subscription row, so the "already subscribed"
    // check only fires against the same product. Buying Profile Stats while
    // holding Stats Editor Pro is allowed (and will be refused as redundant
    // earlier on the client side if needed).
    const product = planConfig.product || 'stats_editor';
    const existingSub = await getOne(`
      SELECT id FROM subscriptions
      WHERE user_id = $1 AND product = $2 AND status = 'active' AND expires_at > NOW() AND plan != 'trial'
    `, [req.user.id, product]);

    if (existingSub) {
      return res.status(400).json({
        error: `You already have an active ${product === 'profile_stats' ? 'Profile Stats' : 'Stats Editor'} subscription`,
        code: 'ALREADY_SUBSCRIBED'
      });
    }

    // Create order ID
    const orderId = `order_${req.user.id}_${plan}_${Date.now()}`;

    // Create payment record in DB — keep product in metadata so the webhook
    // knows which product to bind the subscription to.
    const paymentRecord = await query(`
      INSERT INTO payments (user_id, provider, amount, currency, plan, status, metadata)
      VALUES ($1, 'nowpayments', $2, 'USD', $3, 'pending', $4)
      RETURNING id
    `, [req.user.id, planConfig.price, plan, JSON.stringify({ orderId, product })]);

    const paymentDbId = paymentRecord.rows[0].id;

    // Build callback URLs
    const baseUrl = process.env.APP_URL || 'http://localhost:3000';
    const ipnCallbackUrl = `${baseUrl}/api/webhooks/nowpayments`;
    const successUrl = `${baseUrl}/payment/success?payment_id=${paymentDbId}`;
    const cancelUrl = `${baseUrl}/payment/cancel?payment_id=${paymentDbId}`;

    let paymentResponse;

    if (currency) {
      // Stablecoin pricing: when the user pays in a USDT-based network we
      // quote the price *in that same currency* (price_currency = pay_currency).
      // NOWPayments then skips USD→crypto FX conversion and the user pays
      // exactly the listed amount (e.g. 15 USDT, not 18.7 USDT). For non-USDT
      // currencies we fall back to USD pricing and let NOWPayments quote.
      const cur = currency.toLowerCase();
      const isStable = cur.startsWith('usdt') || cur.startsWith('usdc') || cur === 'dai' || cur === 'busd';

      paymentResponse = await nowpayments.createPayment({
        priceAmount: planConfig.price,
        priceCurrency: isStable ? cur : 'usd',
        payCurrency: cur,
        orderId: `${orderId}_${paymentDbId}`,
        orderDescription: `OF Stats ${planConfig.name} Subscription - 1 Month`,
        ipnCallbackUrl,
        successUrl,
        cancelUrl
      });
    } else {
      // Create invoice (user chooses crypto on NOWPayments page)
      paymentResponse = await nowpayments.createInvoice({
        priceAmount: planConfig.price,
        priceCurrency: 'usd',
        orderId: `${orderId}_${paymentDbId}`,
        orderDescription: `OF Stats ${planConfig.name} Subscription - 1 Month`,
        ipnCallbackUrl,
        successUrl,
        cancelUrl
      });
    }

    // Update payment record with provider ID
    await query(`
      UPDATE payments 
      SET provider_payment_id = $1, 
          crypto_currency = $2,
          metadata = metadata || $3::jsonb
      WHERE id = $4
    `, [
      paymentResponse.payment_id || paymentResponse.id,
      currency?.toUpperCase() || null,
      JSON.stringify(paymentResponse),
      paymentDbId
    ]);

    res.json({
      success: true,
      paymentId: paymentDbId,
      providerPaymentId: paymentResponse.payment_id || paymentResponse.id,
      // For direct payment
      payAddress: paymentResponse.pay_address,
      payAmount: paymentResponse.pay_amount,
      payCurrency: paymentResponse.pay_currency?.toUpperCase(),
      // For invoice
      invoiceUrl: paymentResponse.invoice_url,
      // Common
      expiresAt: paymentResponse.expiration_estimate_date,
      status: 'pending'
    });

  } catch (error) {
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// Check payment status
router.get('/payment-status/:paymentId', authenticateToken, async (req, res) => {
  try {
    const { paymentId } = req.params;

    const payment = await getOne(`
      SELECT p.*, s.status as sub_status
      FROM payments p
      LEFT JOIN subscriptions s ON s.user_id = p.user_id AND s.payment_id = p.provider_payment_id
      WHERE p.id = $1 AND p.user_id = $2
    `, [paymentId, req.user.id]);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // If still pending, check with NOWPayments
    if (payment.status === 'pending' && payment.provider_payment_id) {
      try {
        const providerStatus = await nowpayments.getPaymentStatus(payment.provider_payment_id);
        let mappedStatus = nowpayments.PAYMENT_STATUSES[providerStatus.payment_status] || 'pending';
        
        // If partially paid but >= 98% of amount, treat as completed
        if (providerStatus.payment_status === 'partially_paid' && nowpayments.isPartiallyPaidAcceptable(providerStatus)) {
          console.log('Partial payment accepted as completed (>= 98% paid)');
          mappedStatus = 'completed';
        }
        
        if (mappedStatus !== payment.status) {
          await query('UPDATE payments SET status = $1 WHERE id = $2', [mappedStatus, paymentId]);
          payment.status = mappedStatus;
        }
      } catch (e) {
        console.log('Could not check provider status:', e.message);
      }
    }

    res.json({
      paymentId: payment.id,
      status: payment.status,
      plan: payment.plan,
      amount: payment.amount,
      currency: payment.currency,
      cryptoCurrency: payment.crypto_currency,
      subscriptionActivated: payment.sub_status === 'active',
      createdAt: payment.created_at
    });

  } catch (error) {
    console.error('Check payment status error:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// Get upgrade info (discount calculation)
router.get('/upgrade-info', authenticateToken, async (req, res) => {
  try {
    const subscription = await getOne(`
      SELECT id, plan, model_limit, status, starts_at, expires_at,
        EXTRACT(EPOCH FROM (expires_at - NOW())) / 86400.0 as days_remaining
      FROM subscriptions
      WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()
      ORDER BY expires_at DESC LIMIT 1
    `, [req.user.id]);

    if (!subscription) {
      return res.status(400).json({ error: 'No active subscription to upgrade', code: 'NO_ACTIVE_SUB' });
    }

    if (subscription.plan === 'pro') {
      return res.status(400).json({ error: 'Already on Pro plan', code: 'ALREADY_PRO' });
    }

    if (subscription.plan === 'trial') {
      return res.status(400).json({ error: 'Trial cannot be upgraded, purchase a plan', code: 'TRIAL_NO_UPGRADE' });
    }

    const currentPlanConfig = nowpayments.PLANS[subscription.plan];
    const proPlanConfig = nowpayments.PLANS.pro;
    if (!currentPlanConfig || !proPlanConfig) {
      return res.status(500).json({ error: 'Plan configuration error' });
    }

    const daysRemaining = Math.max(0, parseFloat(subscription.days_remaining));
    const discount = Math.round((daysRemaining / 30) * currentPlanConfig.price * 100) / 100;
    const upgradePrice = Math.max(1, Math.round((proPlanConfig.price - discount) * 100) / 100);

    res.json({
      currentPlan: subscription.plan,
      currentPlanName: currentPlanConfig.name,
      targetPlan: 'pro',
      targetPlanName: proPlanConfig.name,
      currentPrice: currentPlanConfig.price,
      targetPrice: proPlanConfig.price,
      daysRemaining: Math.floor(daysRemaining),
      discount: Math.floor(discount),
      upgradePrice: Math.ceil(upgradePrice),
      newModelLimit: proPlanConfig.modelLimit
    });

  } catch (error) {
    console.error('Get upgrade info error:', error);
    res.status(500).json({ error: 'Failed to get upgrade info' });
  }
});

// Create upgrade payment (discounted)
router.post('/create-upgrade-payment', authenticateToken, async (req, res) => {
  try {
    const { currency } = req.body;

    // Re-calculate upgrade price server-side (prevent tampering)
    const subscription = await getOne(`
      SELECT id, plan, model_limit, status, starts_at, expires_at,
        EXTRACT(EPOCH FROM (expires_at - NOW())) / 86400.0 as days_remaining
      FROM subscriptions
      WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()
      ORDER BY expires_at DESC LIMIT 1
    `, [req.user.id]);

    if (!subscription) {
      return res.status(400).json({ error: 'No active subscription to upgrade', code: 'NO_ACTIVE_SUB' });
    }

    if (subscription.plan === 'pro') {
      return res.status(400).json({ error: 'Already on Pro plan', code: 'ALREADY_PRO' });
    }

    if (subscription.plan === 'trial') {
      return res.status(400).json({ error: 'Trial cannot be upgraded', code: 'TRIAL_NO_UPGRADE' });
    }

    const currentPlanConfig = nowpayments.PLANS[subscription.plan];
    const proPlanConfig = nowpayments.PLANS.pro;

    const daysRemaining = Math.max(0, parseFloat(subscription.days_remaining));
    const discount = Math.round((daysRemaining / 30) * currentPlanConfig.price * 100) / 100;
    const upgradePrice = Math.max(1, Math.ceil(proPlanConfig.price - discount));

    const orderId = `upgrade_${req.user.id}_pro_${Date.now()}`;

    // Create payment record with is_upgrade flag
    const paymentRecord = await query(`
      INSERT INTO payments (user_id, provider, amount, currency, plan, status, metadata)
      VALUES ($1, 'nowpayments', $2, 'USD', 'pro', 'pending', $3)
      RETURNING id
    `, [req.user.id, upgradePrice, JSON.stringify({ orderId, is_upgrade: true, from_plan: subscription.plan, discount })]);

    const paymentDbId = paymentRecord.rows[0].id;

    const baseUrl = process.env.APP_URL || 'http://localhost:3000';
    const ipnCallbackUrl = `${baseUrl}/api/webhooks/nowpayments`;
    const successUrl = `${baseUrl}/payment/success?payment_id=${paymentDbId}`;
    const cancelUrl = `${baseUrl}/payment/cancel?payment_id=${paymentDbId}`;

    let paymentResponse;

    if (currency) {
      // Same stablecoin shortcut as in /create-payment — price in USDT directly
      // so the displayed amount matches the user's actual transfer.
      const cur = currency.toLowerCase();
      const isStable = cur.startsWith('usdt') || cur.startsWith('usdc') || cur === 'dai' || cur === 'busd';
      paymentResponse = await nowpayments.createPayment({
        priceAmount: upgradePrice,
        priceCurrency: isStable ? cur : 'usd',
        payCurrency: cur,
        orderId: `${orderId}_${paymentDbId}`,
        orderDescription: `OF Stats Upgrade to Pro - $${upgradePrice}`,
        ipnCallbackUrl,
        successUrl,
        cancelUrl
      });
    } else {
      paymentResponse = await nowpayments.createInvoice({
        priceAmount: upgradePrice,
        priceCurrency: 'usd',
        orderId: `${orderId}_${paymentDbId}`,
        orderDescription: `OF Stats Upgrade to Pro - $${upgradePrice}`,
        ipnCallbackUrl,
        successUrl,
        cancelUrl
      });
    }

    await query(`
      UPDATE payments 
      SET provider_payment_id = $1, 
          crypto_currency = $2,
          metadata = metadata || $3::jsonb
      WHERE id = $4
    `, [
      paymentResponse.payment_id || paymentResponse.id,
      currency?.toUpperCase() || null,
      JSON.stringify(paymentResponse),
      paymentDbId
    ]);

    res.json({
      success: true,
      paymentId: paymentDbId,
      providerPaymentId: paymentResponse.payment_id || paymentResponse.id,
      payAddress: paymentResponse.pay_address,
      payAmount: paymentResponse.pay_amount,
      payCurrency: paymentResponse.pay_currency?.toUpperCase(),
      invoiceUrl: paymentResponse.invoice_url,
      expiresAt: paymentResponse.expiration_estimate_date,
      status: 'pending',
      upgradePrice,
      discount: Math.floor(discount)
    });

  } catch (error) {
    console.error('Create upgrade payment error:', error);
    res.status(500).json({ error: 'Failed to create upgrade payment' });
  }
});

module.exports = router;
