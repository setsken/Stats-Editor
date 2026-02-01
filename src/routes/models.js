const express = require('express');
const { query, getOne, getMany } = require('../config/database');
const { authenticateToken, requireSubscription } = require('../middleware/auth');

const router = express.Router();

// Get user's models list
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
      WHERE um.user_id = $1
      ORDER BY um.created_at DESC
    `, [req.user.id]);

    res.json({
      models: models.map(m => ({
        id: m.id,
        username: m.model_username,
        displayName: m.display_name,
        createdAt: m.created_at,
        lastFans: m.last_fans
      })),
      count: models.length,
      limit: req.subscription.model_limit // null = unlimited
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

    // Check model limit (if not unlimited)
    if (req.subscription.model_limit !== null) {
      const countResult = await getOne(
        'SELECT COUNT(*) as count FROM user_models WHERE user_id = $1',
        [req.user.id]
      );

      const currentCount = parseInt(countResult.count);
      
      if (currentCount >= req.subscription.model_limit) {
        return res.status(403).json({ 
          error: `Model limit reached (${req.subscription.model_limit})`,
          code: 'MODEL_LIMIT_REACHED',
          currentCount,
          limit: req.subscription.model_limit
        });
      }
    }

    // Check if model already added
    const existing = await getOne(
      'SELECT id FROM user_models WHERE user_id = $1 AND model_username = $2',
      [req.user.id, cleanUsername]
    );

    if (existing) {
      return res.status(409).json({ 
        error: 'Model already added',
        code: 'MODEL_EXISTS'
      });
    }

    // Add model
    const result = await query(`
      INSERT INTO user_models (user_id, model_username, display_name)
      VALUES ($1, $2, $3)
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

// Remove a model
router.delete('/:username', authenticateToken, async (req, res) => {
  try {
    const { username } = req.params;
    const cleanUsername = username.trim().toLowerCase().replace('@', '');

    const result = await query(
      'DELETE FROM user_models WHERE user_id = $1 AND model_username = $2 RETURNING id',
      [req.user.id, cleanUsername]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Model not found' });
    }

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
