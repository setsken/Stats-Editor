const express = require('express');
const { query, getOne } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// ==================== GET all presets for user ====================
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT name, preset_data, active, updated_at 
       FROM user_presets 
       WHERE user_id = $1 
       ORDER BY name ASC`,
      [req.user.id]
    );

    const presets = {};
    let activePreset = '';

    for (const row of result.rows) {
      presets[row.name] = row.preset_data;
      if (row.active) {
        activePreset = row.name;
      }
    }

    res.json({
      success: true,
      presets,
      activePreset,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Get presets error:', error);
    res.status(500).json({ error: 'Failed to load presets' });
  }
});

// ==================== SAVE / update all presets (full sync) ====================
router.put('/sync', async (req, res) => {
  try {
    const { presets, activePreset } = req.body;

    if (!presets || typeof presets !== 'object') {
      return res.status(400).json({ error: 'Invalid presets data' });
    }

    // Use a transaction for atomic operation
    const client = (await require('../config/database').pool.connect());
    try {
      await client.query('BEGIN');

      // Get existing preset names for this user
      const existing = await client.query(
        'SELECT name FROM user_presets WHERE user_id = $1',
        [req.user.id]
      );
      const existingNames = new Set(existing.rows.map(r => r.name));
      const newNames = new Set(Object.keys(presets));

      // Delete presets that no longer exist
      for (const name of existingNames) {
        if (!newNames.has(name)) {
          await client.query(
            'DELETE FROM user_presets WHERE user_id = $1 AND name = $2',
            [req.user.id, name]
          );
        }
      }

      // Upsert each preset
      for (const [name, data] of Object.entries(presets)) {
        const isActive = activePreset === name;
        await client.query(
          `INSERT INTO user_presets (user_id, name, preset_data, active, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (user_id, name)
           DO UPDATE SET preset_data = $3, active = $4, updated_at = NOW()`,
          [req.user.id, name, JSON.stringify(data), isActive]
        );
      }

      // If activePreset is empty or not in presets, deactivate all
      if (!activePreset || !newNames.has(activePreset)) {
        await client.query(
          'UPDATE user_presets SET active = false WHERE user_id = $1',
          [req.user.id]
        );
      }

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Presets synced',
        count: Object.keys(presets).length
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Sync presets error:', error);
    res.status(500).json({ error: 'Failed to sync presets' });
  }
});

// ==================== SAVE single preset ====================
router.put('/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { presetData, active } = req.body;

    if (!name || !presetData) {
      return res.status(400).json({ error: 'Name and preset data are required' });
    }

    if (name.length > 100) {
      return res.status(400).json({ error: 'Preset name too long (max 100 chars)' });
    }

    // Check preset count limit (max 50 presets per user)
    const countResult = await getOne(
      'SELECT COUNT(*) as count FROM user_presets WHERE user_id = $1',
      [req.user.id]
    );
    
    const existingPreset = await getOne(
      'SELECT id FROM user_presets WHERE user_id = $1 AND name = $2',
      [req.user.id, name]
    );

    if (!existingPreset && parseInt(countResult.count) >= 50) {
      return res.status(400).json({ error: 'Maximum 50 presets allowed' });
    }

    // If setting as active, deactivate others first
    if (active) {
      await query(
        'UPDATE user_presets SET active = false WHERE user_id = $1',
        [req.user.id]
      );
    }

    await query(
      `INSERT INTO user_presets (user_id, name, preset_data, active, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, name)
       DO UPDATE SET preset_data = $3, active = $4, updated_at = NOW()`,
      [req.user.id, name, JSON.stringify(presetData), active || false]
    );

    res.json({ success: true, message: 'Preset saved' });
  } catch (error) {
    console.error('Save preset error:', error);
    res.status(500).json({ error: 'Failed to save preset' });
  }
});

// ==================== SET active preset ====================
router.put('/active/:name', async (req, res) => {
  try {
    const { name } = req.params;

    // Deactivate all presets for user
    await query(
      'UPDATE user_presets SET active = false WHERE user_id = $1',
      [req.user.id]
    );

    if (name && name !== '__none__') {
      // Activate the specified preset
      const result = await query(
        'UPDATE user_presets SET active = true WHERE user_id = $1 AND name = $2',
        [req.user.id, name]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Preset not found' });
      }
    }

    res.json({ success: true, message: 'Active preset updated' });
  } catch (error) {
    console.error('Set active preset error:', error);
    res.status(500).json({ error: 'Failed to set active preset' });
  }
});

// ==================== DELETE preset ====================
router.delete('/:name', async (req, res) => {
  try {
    const { name } = req.params;

    const result = await query(
      'DELETE FROM user_presets WHERE user_id = $1 AND name = $2',
      [req.user.id, name]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Preset not found' });
    }

    res.json({ success: true, message: 'Preset deleted' });
  } catch (error) {
    console.error('Delete preset error:', error);
    res.status(500).json({ error: 'Failed to delete preset' });
  }
});

module.exports = router;
