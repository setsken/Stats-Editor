const express = require('express');
const { query, getOne, getMany } = require('../config/database');
const { authenticateToken, requireSubscription } = require('../middleware/auth');

const router = express.Router();

// Get user's models list (only active, not deleted)
router.get('/', authenticateToken, requireSubscription, async (req, res) => {
  try {
    const models = await getMany(`
      SELECT
        um.id,
        um.model_username,
        um.display_name,
        um.created_at,
        (
          SELECT json_build_object(
            'fans_count', mfh.fans_count,
            'fans_text', mfh.fans_text,
            'recorded_at', mfh.recorded_at
          )
          FROM model_fans_history mfh
          WHERE mfh.model_username = um.model_username
          ORDER BY mfh.recorded_at DESC
          LIMIT 1
        ) as last_fans
      FROM user_models um
      WHERE um.user_id = $1 AND (um.is_deleted = false OR um.is_deleted IS NULL)
      ORDER BY um.created_at DESC
    `, [req.user.id]);

    // Count unique models added this subscription period
    const uniqueCount = await getOne(`
      SELECT COUNT(*) as count 
      FROM user_models 
      WHERE user_id = $1 AND created_at >= $2
    `, [req.user.id, req.subscription.starts_at]);

    res.json({
      models: models.map(m => ({
        id: m.id,
        username: m.model_username,
        displayName: m.display_name,
        createdAt: m.created_at,
        lastFans: m.last_fans
      })),
      count: models.length,
      uniqueThisPeriod: parseInt(uniqueCount.count),
      limit: req.subscription.model_limit, // null = unlimited
      periodStart: req.subscription.starts_at
    });

  } catch (error) {
    console.error('Get models error:', error);
    res.status(500).json({ error: 'Failed to get models' });
  }
});

// Add a model
router.post('/add', authenticateToken, requireSubscription, async (req, res) => {
  try {
    const { username, displayName } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Model username is required' });
    }

    // Clean username (remove @ and extra spaces)
    const cleanUsername = username.trim().toLowerCase().replace('@', '');

    // Check if model was previously added (even if deleted) - can restore for free
    const existingModel = await getOne(
      'SELECT id, is_deleted, created_at FROM user_models WHERE user_id = $1 AND model_username = $2',
      [req.user.id, cleanUsername]
    );

    if (existingModel) {
      if (existingModel.is_deleted) {
        // Model was deleted - restore it (doesn't count as new unique)
        await query(
          'UPDATE user_models SET is_deleted = false, deleted_at = NULL, display_name = COALESCE($3, display_name) WHERE id = $1',
          [existingModel.id, req.user.id, displayName]
        );

        return res.status(200).json({
          message: 'Model restored successfully',
          restored: true,
          model: {
            id: existingModel.id,
            username: cleanUsername,
            displayName: displayName,
            createdAt: existingModel.created_at
          }
        });
      } else {
        // Model already active
        return res.status(409).json({
          error: 'Model already added',
          code: 'MODEL_EXISTS'
        });
      }
    }

    // New model - check unique models limit for this subscription period
    if (req.subscription.model_limit !== null) {
      // Count unique models added since subscription started
      const uniqueCount = await getOne(`
        SELECT COUNT(*) as count 
        FROM user_models 
        WHERE user_id = $1 AND created_at >= $2
      `, [req.user.id, req.subscription.starts_at]);

      const currentUniqueCount = parseInt(uniqueCount.count);

      if (currentUniqueCount >= req.subscription.model_limit) {
        return res.status(403).json({
          error: `Unique models limit reached for this period (${req.subscription.model_limit})`,
          code: 'MODEL_LIMIT_REACHED',
          currentCount: currentUniqueCount,
          limit: req.subscription.model_limit,
          periodStart: req.subscription.starts_at,
          hint: 'Your limit resets when subscription period renews'
        });
      }
    }

    // Add new model
    const result = await query(`
      INSERT INTO user_models (user_id, model_username, display_name, is_deleted)
      VALUES ($1, $2, $3, false)
      RETURNING id, model_username, display_name, created_at
    `, [req.user.id, cleanUsername, displayName || null]);

    const model = result.rows[0];

    res.status(201).json({
      message: 'Model added successfully',
      model: {
        id: model.id,
        username: model.model_username,
        displayName: model.display_name,
        createdAt: model.created_at
      }
    });

  } catch (error) {
    console.error('Add model error:', error);
    res.status(500).json({ error: 'Failed to add model' });
  }
});

// Remove a model (soft delete - keeps history, can be restored)
router.delete('/:username', authenticateToken, async (req, res) => {
  try {
    const { username } = req.params;
    const cleanUsername = username.trim().toLowerCase().replace('@', '');

    // Soft delete - mark as deleted but keep record
    const result = await query(
      `UPDATE user_models 
       SET is_deleted = true, deleted_at = NOW() 
       WHERE user_id = $1 AND model_username = $2 AND (is_deleted = false OR is_deleted IS NULL)
       RETURNING id`,

    res.json({ message: 'Model removed successfully' });

  } catch (error) {
    console.error('Remove model error:', error);
    res.status(500).json({ error: 'Failed to remove model' });
  }
});

// Check if model is in user's list
router.get('/check/:username', authenticateToken, async (req, res) => {
  try {
    const { username } = req.params;
    const cleanUsername = username.trim().toLowerCase().replace('@', '');

    const model = await getOne(
      'SELECT id FROM user_models WHERE user_id = $1 AND model_username = $2',
      [req.user.id, cleanUsername]
    );

    res.json({
      username: cleanUsername,
      isAdded: !!model,
      modelId: model?.id || null
    });

  } catch (error) {
    console.error('Check model error:', error);
    res.status(500).json({ error: 'Failed to check model' });
  }
});

module.exports = router;
