const express = require('express');
const { query, getOne, getMany } = require('../config/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// DEBUG: Get all recent fans records (for testing)
router.get('/debug/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const records = await getMany(`
      SELECT model_username, fans_count, fans_text, recorded_at
      FROM model_fans_history
      ORDER BY recorded_at DESC
      LIMIT $1
    `, [limit]);
    
    res.json({
      count: records.length,
      records: records.map(r => ({
        username: r.model_username,
        fans: r.fans_text || r.fans_count,
        recordedAt: r.recorded_at
      }))
    });
  } catch (error) {
    console.error('Debug fans error:', error);
    res.status(500).json({ error: 'Failed to get fans data' });
  }
});

// Report fans count for a model (when user visits profile with visible fans)
router.post('/report', authenticateToken, async (req, res) => {
  try {
    const { username, fansCount, fansText } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Model username is required' });
    }

    if (fansCount === undefined && !fansText) {
      return res.status(400).json({ error: 'Fans count or text is required' });
    }

    const cleanUsername = username.trim().toLowerCase().replace('@', '');

    // Parse fans count from text if needed (e.g., "18.5K" -> 18500)
    let parsedFansCount = fansCount;
    if (!parsedFansCount && fansText) {
      parsedFansCount = parseFansText(fansText);
    }

    // Check if we already have a recent record (within last hour) to avoid duplicates
    const recent = await getOne(`
      SELECT id, fans_count FROM model_fans_history 
      WHERE model_username = $1 AND recorded_at > NOW() - INTERVAL '1 hour'
      ORDER BY recorded_at DESC
      LIMIT 1
    `, [cleanUsername]);

    if (recent && recent.fans_count === parsedFansCount) {
      return res.json({ 
        message: 'Fans already recorded recently',
        recorded: false 
      });
    }

    // Insert new record
    await query(`
      INSERT INTO model_fans_history (model_username, fans_count, fans_text, recorded_by)
      VALUES ($1, $2, $3, $4)
    `, [cleanUsername, parsedFansCount, fansText || formatFansCount(parsedFansCount), req.user.id]);

    res.json({
      message: 'Fans recorded successfully',
      recorded: true,
      data: {
        username: cleanUsername,
        fansCount: parsedFansCount,
        fansText: fansText || formatFansCount(parsedFansCount)
      }
    });

  } catch (error) {
    console.error('Report fans error:', error);
    res.status(500).json({ error: 'Failed to report fans' });
  }
});

// Get last known fans for a model (public - for hidden fans feature)
router.get('/:username', optionalAuth, async (req, res) => {
  try {
    const { username } = req.params;
    const cleanUsername = username.trim().toLowerCase().replace('@', '');

    const lastFans = await getOne(`
      SELECT fans_count, fans_text, recorded_at
      FROM model_fans_history
      WHERE model_username = $1
      ORDER BY recorded_at DESC
      LIMIT 1
    `, [cleanUsername]);

    if (!lastFans) {
      return res.json({
        username: cleanUsername,
        found: false,
        lastFans: null
      });
    }

    res.json({
      username: cleanUsername,
      found: true,
      lastFans: {
        count: lastFans.fans_count,
        text: lastFans.fans_text,
        recordedAt: lastFans.recorded_at,
        formattedDate: formatDate(lastFans.recorded_at)
      }
    });

  } catch (error) {
    console.error('Get fans error:', error);
    res.status(500).json({ error: 'Failed to get fans data' });
  }
});

// Get fans history for a model
router.get('/:username/history', authenticateToken, async (req, res) => {
  try {
    const { username } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const cleanUsername = username.trim().toLowerCase().replace('@', '');

    const history = await getMany(`
      SELECT fans_count, fans_text, recorded_at
      FROM model_fans_history
      WHERE model_username = $1
      ORDER BY recorded_at DESC
      LIMIT $2
    `, [cleanUsername, limit]);

    res.json({
      username: cleanUsername,
      history: history.map(h => ({
        count: h.fans_count,
        text: h.fans_text,
        recordedAt: h.recorded_at,
        formattedDate: formatDate(h.recorded_at)
      })),
      count: history.length
    });

  } catch (error) {
    console.error('Get fans history error:', error);
    res.status(500).json({ error: 'Failed to get fans history' });
  }
});

// Batch get fans for multiple models (for plugin efficiency)
router.post('/batch', optionalAuth, async (req, res) => {
  try {
    const { usernames } = req.body;

    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'Usernames array is required' });
    }

    // Limit batch size
    const limitedUsernames = usernames.slice(0, 50).map(u => 
      u.trim().toLowerCase().replace('@', '')
    );

    const results = await getMany(`
      SELECT DISTINCT ON (model_username) 
        model_username, fans_count, fans_text, recorded_at
      FROM model_fans_history
      WHERE model_username = ANY($1)
      ORDER BY model_username, recorded_at DESC
    `, [limitedUsernames]);

    // Create map for easy lookup
    const fansMap = {};
    results.forEach(r => {
      fansMap[r.model_username] = {
        count: r.fans_count,
        text: r.fans_text,
        recordedAt: r.recorded_at,
        formattedDate: formatDate(r.recorded_at)
      };
    });

    res.json({
      fans: fansMap,
      found: results.length,
      requested: limitedUsernames.length
    });

  } catch (error) {
    console.error('Batch get fans error:', error);
    res.status(500).json({ error: 'Failed to get fans data' });
  }
});

// Helper: Parse fans text to number (e.g., "18.5K" -> 18500)
function parseFansText(text) {
  if (!text) return null;
  
  const cleaned = text.toString().trim().toUpperCase();
  
  // Handle "K" suffix (thousands)
  if (cleaned.endsWith('K')) {
    const num = parseFloat(cleaned.replace('K', ''));
    return Math.round(num * 1000);
  }
  
  // Handle "M" suffix (millions)
  if (cleaned.endsWith('M')) {
    const num = parseFloat(cleaned.replace('M', ''));
    return Math.round(num * 1000000);
  }
  
  // Plain number
  return parseInt(cleaned.replace(/[^0-9]/g, '')) || null;
}

// Helper: Format fans count to text (e.g., 18500 -> "18.5K")
function formatFansCount(count) {
  if (!count) return null;
  
  if (count >= 1000000) {
    return (count / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  
  if (count >= 1000) {
    return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  
  return count.toString();
}

// Helper: Format date (e.g., "01.02.26")
function formatDate(date) {
  const d = new Date(date);
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const year = d.getFullYear().toString().slice(-2);
  return `${day}.${month}.${year}`;
}

module.exports = router;
