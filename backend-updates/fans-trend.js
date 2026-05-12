const express = require('express');
const { query, getOne } = require('../config/database');

const router = express.Router();

// POST /fans/report — existing logic + UPSERT into model_fans_daily
router.post('/report', async (req, res) => {
  try {
    const { username, fansCount, fansText } = req.body;

    if (!username || fansCount === undefined || fansCount === null) {
      return res.status(400).json({ error: 'Missing username or fansCount' });
    }

    const fansNum = parseInt(fansCount, 10);
    if (isNaN(fansNum) || fansNum < 0) {
      return res.status(400).json({ error: 'Invalid fansCount' });
    }

    // Get user ID from auth if available
    let reportedBy = null;
    if (req.user && req.user.id) {
      reportedBy = req.user.id;
    }

    // Original: insert into fans_reports
    await query(
      'INSERT INTO fans_reports (model_username, fans_count, fans_text, reported_by) VALUES ($1, $2, $3, $4)',
      [username, fansNum, fansText || null, reportedBy]
    );

    // NEW: UPSERT into model_fans_daily for trend tracking
    try {
      await query(
        `INSERT INTO model_fans_daily (model_username, day, fans_count, reporters, updated_at)
         VALUES ($1, CURRENT_DATE, $2, 1, NOW())
         ON CONFLICT (model_username, day)
         DO UPDATE SET fans_count = $2, reporters = model_fans_daily.reporters + 1, updated_at = NOW()`,
        [username, fansNum]
      );
    } catch (trendErr) {
      // Non-critical: don't fail the whole report if trend insert fails
      console.error('Fans trend UPSERT error (non-critical):', trendErr.message);
    }

    res.json({ recorded: true });
  } catch (error) {
    console.error('Report fans error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /fans/trend/:username — get daily fans history for sparkline
router.get('/trend/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const days = Math.min(parseInt(req.query.days) || 90, 365);

    if (!username) {
      return res.status(400).json({ error: 'Missing username' });
    }

    const result = await query(
      `SELECT day, fans_count FROM model_fans_daily
       WHERE model_username = $1 AND day >= CURRENT_DATE - $2::integer
       ORDER BY day ASC`,
      [username, days]
    );

    const points = result.rows.map(r => ({
      d: r.day.toISOString().slice(0, 10),
      f: r.fans_count
    }));

    res.json({ username, points });
  } catch (error) {
    console.error('Get fans trend error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /fans/:username — get last known fans count
router.get('/:username', async (req, res) => {
  try {
    const { username } = req.params;

    const row = await getOne(
      'SELECT fans_count, fans_text, reported_at FROM fans_reports WHERE model_username = $1 ORDER BY reported_at DESC LIMIT 1',
      [username]
    );

    if (row) {
      res.json({
        found: true,
        lastFans: {
          count: row.fans_count,
          text: row.fans_text,
          recordedAt: row.reported_at,
          formattedDate: row.reported_at ? new Date(row.reported_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null
        }
      });
    } else {
      res.json({ found: false });
    }
  } catch (error) {
    console.error('Get fans error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /fans/batch — batch get last known fans
router.post('/batch', async (req, res) => {
  try {
    const { usernames } = req.body;

    if (!usernames || !Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'Missing usernames array' });
    }

    // Limit batch size
    const limitedUsernames = usernames.slice(0, 100);

    const result = await query(
      `SELECT DISTINCT ON (model_username) model_username, fans_count, fans_text, reported_at
       FROM fans_reports
       WHERE model_username = ANY($1)
       ORDER BY model_username, reported_at DESC`,
      [limitedUsernames]
    );

    const fansMap = {};
    result.rows.forEach(row => {
      fansMap[row.model_username] = {
        count: row.fans_count,
        text: row.fans_text,
        recordedAt: row.reported_at
      };
    });

    res.json({ fans: fansMap });
  } catch (error) {
    console.error('Batch get fans error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
