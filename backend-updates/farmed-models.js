// Routes for farmed models — comment status check
// Maps to: of-stats-backend/src/routes/farmed-models.js

const express = require('express');
const router = express.Router();
const { getOne, query } = require('../config/database');

// GET /api/farmed-models/:username — check comment status for a model
// Public endpoint (no auth required)
router.get('/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase().trim();

    if (!username || username.length > 255) {
      return res.status(400).json({ error: 'Invalid username' });
    }

    const model = await getOne(
      'SELECT username, status, found_at FROM farmed_models WHERE username = $1',
      [username]
    );

    if (!model) {
      return res.json({ found: false, username, status: null });
    }

    return res.json({
      found: true,
      username: model.username,
      status: model.status, // 'ready', 'none', or null
      found_at: model.found_at
    });
  } catch (error) {
    console.error('Error checking farmed model:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/farmed-models/bulk — check multiple models at once
// Public endpoint (no auth required)
router.post('/bulk', async (req, res) => {
  try {
    const { usernames } = req.body;

    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'usernames must be a non-empty array' });
    }

    // Limit to 50 at once
    const limited = usernames.slice(0, 50).map(u => u.toLowerCase().trim());

    const placeholders = limited.map((_, i) => `$${i + 1}`).join(',');
    const result = await query(
      `SELECT username, status, found_at FROM farmed_models WHERE username IN (${placeholders})`,
      limited
    );

    const models = {};
    result.rows.forEach(row => {
      models[row.username] = { status: row.status, found_at: row.found_at };
    });

    return res.json({ models });
  } catch (error) {
    console.error('Error bulk checking farmed models:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/farmed-models/sync — upload farmed models data (requires secret key)
router.post('/sync', async (req, res) => {
  try {
    const authKey = req.headers['x-sync-key'];
    if (!authKey || authKey !== process.env.FARMED_SYNC_KEY) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { models } = req.body;

    if (!Array.isArray(models) || models.length === 0) {
      return res.status(400).json({ error: 'models must be a non-empty array' });
    }

    let inserted = 0;
    let updated = 0;

    // Process in batches of 100
    for (let i = 0; i < models.length; i += 100) {
      const batch = models.slice(i, i + 100);
      const values = [];
      const placeholders = [];

      batch.forEach((m, idx) => {
        const offset = idx * 4;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
        values.push(
          m.username.toLowerCase().trim(),
          m.of_url || `https://onlyfans.com/${m.username.toLowerCase().trim()}`,
          m.found_at || new Date().toISOString(),
          m.status || null
        );
      });

      const result = await query(
        `INSERT INTO farmed_models (username, of_url, found_at, status)
         VALUES ${placeholders.join(',')}
         ON CONFLICT (username)
         DO UPDATE SET status = EXCLUDED.status, found_at = EXCLUDED.found_at`,
        values
      );

      inserted += result.rowCount;
    }

    return res.json({ success: true, processed: models.length });
  } catch (error) {
    console.error('Error syncing farmed models:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
