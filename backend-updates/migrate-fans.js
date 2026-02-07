// One-time migration script to clean up model_fans_history duplicates
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function migrate() {
  console.log('🔄 Starting model_fans_history migration...');
  
  try {
    // Count before
    const before = await pool.query('SELECT COUNT(*) as count FROM model_fans_history');
    console.log(`📊 Records before cleanup: ${before.rows[0].count}`);
    
    // Count unique models
    const unique = await pool.query('SELECT COUNT(DISTINCT model_username) as count FROM model_fans_history');
    console.log(`📊 Unique models: ${unique.rows[0].count}`);
    
    // Delete all duplicates, keeping only the latest record (highest id) for each model
    const deleted = await pool.query(`
      DELETE FROM model_fans_history a
      USING model_fans_history b
      WHERE a.id < b.id 
        AND a.model_username = b.model_username
    `);
    console.log(`✅ Deleted ${deleted.rowCount} duplicate records`);
    
    // Count after
    const after = await pool.query('SELECT COUNT(*) as count FROM model_fans_history');
    console.log(`📊 Records after cleanup: ${after.rows[0].count}`);
    
    // Add unique constraint on model_username if not exists
    try {
      await pool.query(`
        ALTER TABLE model_fans_history 
        ADD CONSTRAINT model_fans_history_username_unique UNIQUE (model_username)
      `);
      console.log('✅ Added unique constraint on model_username');
    } catch (err) {
      if (err.code === '42710') {
        console.log('ℹ️ Unique constraint already exists');
      } else {
        throw err;
      }
    }
    
    console.log('🎉 Migration complete!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
