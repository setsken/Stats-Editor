const express = require('express');
const crypto = require('crypto');
const { query, getOne } = require('../config/database');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');

const router = express.Router();

// Generate random promo code
function generatePromoCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluding confusing chars like 0, O, 1, I
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ==================== ADMIN ENDPOINTS ====================

// Create promo code (admin only)
router.post('/admin/create', authenticateAdmin, async (req, res) => {
  try {
    const {
      code, // Optional - if not provided, generate random
      plan = 'pro',
      product = 'stats_editor', // 'stats_editor' | 'profile_stats'
      days = 30,
      modelLimit = 50,
      maxUses = 1, // null for unlimited
      expiresAt = null // Optional expiry date for the code itself
    } = req.body;

    if (!['stats_editor', 'profile_stats'].includes(product)) {
      return res.status(400).json({ error: 'Invalid product. Use "stats_editor" or "profile_stats".' });
    }

    // Generate code if not provided
    const promoCode = code || generatePromoCode();

    // Check if code already exists
    const existing = await getOne('SELECT id FROM promo_codes WHERE code = $1', [promoCode.toUpperCase()]);
    if (existing) {
      return res.status(409).json({ error: 'Promo code already exists' });
    }

    const result = await query(
      `INSERT INTO promo_codes (code, plan, product, days, model_limit, max_uses, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [promoCode.toUpperCase(), plan, product, days, modelLimit, maxUses, expiresAt, req.user.email]
    );

    res.status(201).json({
      success: true,
      promoCode: result.rows[0]
    });

  } catch (error) {
    console.error('Create promo code error:', error);
    res.status(500).json({ error: 'Failed to create promo code' });
  }
});

// Generate multiple promo codes (admin only)
router.post('/admin/generate-batch', authenticateAdmin, async (req, res) => {
  try {
    const {
      count = 10,
      prefix = '',
      plan = 'pro',
      product = 'stats_editor',
      days = 30,
      modelLimit = 50,
      maxUses = 1,
      expiresAt = null
    } = req.body;

    if (!['stats_editor', 'profile_stats'].includes(product)) {
      return res.status(400).json({ error: 'Invalid product. Use "stats_editor" or "profile_stats".' });
    }

    if (count > 100) {
      return res.status(400).json({ error: 'Maximum 100 codes per batch' });
    }

    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = prefix ? `${prefix.toUpperCase()}-${generatePromoCode(6)}` : generatePromoCode();

      try {
        const result = await query(
          `INSERT INTO promo_codes (code, plan, product, days, model_limit, max_uses, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [code.toUpperCase(), plan, product, days, modelLimit, maxUses, expiresAt, req.user.email]
        );
        codes.push(result.rows[0]);
      } catch (err) {
        // Skip duplicate codes
        if (err.code !== '23505') throw err;
        i--; // Retry with new code
      }
    }

    res.status(201).json({
      success: true,
      count: codes.length,
      codes: codes
    });

  } catch (error) {
    console.error('Generate batch promo codes error:', error);
    res.status(500).json({ error: 'Failed to generate promo codes' });
  }
});

// List all promo codes (admin only)
router.get('/admin/list', authenticateAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT pc.*, 
        (SELECT COUNT(*) FROM promo_code_uses WHERE promo_code_id = pc.id) as uses_count
      FROM promo_codes pc
      ORDER BY pc.created_at DESC
    `);

    res.json({
      success: true,
      promoCodes: result.rows
    });

  } catch (error) {
    console.error('List promo codes error:', error);
    res.status(500).json({ error: 'Failed to list promo codes' });
  }
});

// Get promo code details (admin only)
router.get('/admin/:id', authenticateAdmin, async (req, res) => {
  try {
    const code = await getOne('SELECT * FROM promo_codes WHERE id = $1', [req.params.id]);
    
    if (!code) {
      return res.status(404).json({ error: 'Promo code not found' });
    }

    // Get usage history
    const uses = await query(`
      SELECT pcu.used_at, u.email 
      FROM promo_code_uses pcu
      JOIN users u ON u.id = pcu.user_id
      WHERE pcu.promo_code_id = $1
      ORDER BY pcu.used_at DESC
    `, [req.params.id]);

    res.json({
      success: true,
      promoCode: code,
      uses: uses.rows
    });

  } catch (error) {
    console.error('Get promo code error:', error);
    res.status(500).json({ error: 'Failed to get promo code' });
  }
});

// Delete promo code (admin only)
router.delete('/admin/:id', authenticateAdmin, async (req, res) => {
  try {
    await query('DELETE FROM promo_codes WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Promo code deleted' });
  } catch (error) {
    console.error('Delete promo code error:', error);
    res.status(500).json({ error: 'Failed to delete promo code' });
  }
});

// Toggle promo code active status (admin only)
router.patch('/admin/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    const result = await query(
      'UPDATE promo_codes SET is_active = NOT is_active WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promo code not found' });
    }

    res.json({
      success: true,
      promoCode: result.rows[0]
    });

  } catch (error) {
    console.error('Toggle promo code error:', error);
    res.status(500).json({ error: 'Failed to toggle promo code' });
  }
});

// ==================== USER ENDPOINTS ====================

// Apply promo code (authenticated users)
router.post('/apply', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    const userId = req.user.id;

    if (!code) {
      return res.status(400).json({ error: 'Promo code is required', code: 'INVALID_CODE' });
    }

    // Find promo code
    const promoCode = await getOne(
      'SELECT * FROM promo_codes WHERE code = $1',
      [code.toUpperCase().trim()]
    );

    if (!promoCode) {
      return res.status(404).json({ error: 'Invalid promo code', code: 'INVALID_CODE' });
    }

    // Check if active
    if (!promoCode.is_active) {
      return res.status(400).json({ error: 'This promo code is no longer active', code: 'EXPIRED' });
    }

    // Check if expired
    if (promoCode.expires_at && new Date(promoCode.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This promo code has expired', code: 'EXPIRED' });
    }

    // Check usage limit
    if (promoCode.max_uses !== null && promoCode.current_uses >= promoCode.max_uses) {
      return res.status(400).json({ error: 'This promo code has reached its usage limit', code: 'LIMIT_REACHED' });
    }

    // Check if user already used this code
    const alreadyUsed = await getOne(
      'SELECT id FROM promo_code_uses WHERE promo_code_id = $1 AND user_id = $2',
      [promoCode.id, userId]
    );

    if (alreadyUsed) {
      return res.status(400).json({ error: 'You have already used this promo code', code: 'ALREADY_USED' });
    }

    // Multi-product split: each promo code carries its product. Older rows
    // default to 'stats_editor' via the migration, so legacy codes still work.
    const product = promoCode.product || 'stats_editor';
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + promoCode.days);

    // Look up the existing subscription FOR THIS PRODUCT to decide whether to
    // extend (active) or replace (inactive/missing). We can't rely on a single
    // unique (user_id) constraint anymore since users can have one row per
    // product — query first, then INSERT or UPDATE explicitly.
    const existing = await getOne(
      `SELECT id, status, expires_at FROM subscriptions
       WHERE user_id = $1 AND product = $2
       ORDER BY expires_at DESC LIMIT 1`,
      [userId, product]
    );

    const wasActive = existing
      && existing.status === 'active'
      && new Date(existing.expires_at) > new Date();

    if (existing) {
      // Extend if currently active, otherwise restart from now.
      const newExpires = wasActive
        ? new Date(new Date(existing.expires_at).getTime() + promoCode.days * 86400000)
        : expiresAt;
      const newStarts = wasActive ? null : new Date(); // null = keep starts_at via COALESCE
      await query(
        `UPDATE subscriptions
         SET plan = $1, model_limit = $2, status = 'active', payment_provider = 'promo',
             starts_at = COALESCE($3, starts_at),
             expires_at = $4,
             updated_at = NOW(),
             product = $5
         WHERE id = $6`,
        [promoCode.plan, promoCode.model_limit, newStarts, newExpires, product, existing.id]
      );
    } else {
      await query(
        `INSERT INTO subscriptions (
           user_id, plan, product, model_limit, status, payment_provider,
           starts_at, expires_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'active', 'promo', NOW(), $5, NOW(), NOW())`,
        [userId, promoCode.plan, product, promoCode.model_limit, expiresAt]
      );
    }

    // Clear user_models ONLY for stats_editor sign-ups: the model slot list
    // belongs to that product. Profile Stats has no per-model storage that
    // needs resetting on a promo redemption.
    if (product === 'stats_editor' && (!existing || !wasActive)) {
      await query(`DELETE FROM user_models WHERE user_id = $1`, [userId]);
      console.log(`Cleared models for user ${userId} (new promo subscription, product=stats_editor)`);
    }

    // Record usage + bump counter
    await query(
      'INSERT INTO promo_code_uses (promo_code_id, user_id) VALUES ($1, $2)',
      [promoCode.id, userId]
    );
    await query(
      'UPDATE promo_codes SET current_uses = current_uses + 1 WHERE id = $1',
      [promoCode.id]
    );

    res.json({
      success: true,
      message: `Promo code applied! You now have ${promoCode.days} days of ${promoCode.plan.toUpperCase()} subscription.`,
      subscription: {
        plan: promoCode.plan,
        product,
        days: promoCode.days,
        modelLimit: promoCode.model_limit
      }
    });

  } catch (error) {
    console.error('Apply promo code error:', error);
    res.status(500).json({ error: 'Failed to apply promo code' });
  }
});

module.exports = router;
