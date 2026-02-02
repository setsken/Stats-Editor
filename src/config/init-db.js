require('dotenv').config();
const { pool } = require('./database');

const initDatabase = async () => {
  console.log('🔧 Initializing database...');
  
  try {
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        trial_started_at TIMESTAMP,
        trial_used BOOLEAN DEFAULT FALSE,
        last_login_at TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        email_verified BOOLEAN DEFAULT FALSE,
        email_verification_code VARCHAR(10),
        email_verification_expires TIMESTAMP,
        password_reset_token VARCHAR(255),
        password_reset_expires TIMESTAMP
      );
    `);
    console.log('✅ Table "users" ready');

    // Add columns for existing tables (migration)
    const columnsToAdd = [
      { name: 'email_verified', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'email_verification_code', type: 'VARCHAR(10)' },
      { name: 'email_verification_expires', type: 'TIMESTAMP' },
      { name: 'password_reset_token', type: 'VARCHAR(255)' },
      { name: 'password_reset_expires', type: 'TIMESTAMP' }
    ];

    for (const col of columnsToAdd) {
      try {
        await pool.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✅ Added column: ${col.name}`);
      } catch (err) {
        if (err.code === '42701') { // Column already exists
          console.log(`ℹ️ Column ${col.name} already exists`);
        } else {
          console.error(`Error adding column ${col.name}:`, err.message);
        }
      }
    }

    // Create subscriptions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        plan VARCHAR(50) NOT NULL,
        model_limit INTEGER,
        status VARCHAR(50) DEFAULT 'active',
        payment_provider VARCHAR(50),
        payment_id VARCHAR(255),
        starts_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "subscriptions" ready');

    // Create payments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL,
        provider_payment_id VARCHAR(255),
        amount DECIMAL(10,2),
        currency VARCHAR(10),
        crypto_currency VARCHAR(20),
        crypto_amount DECIMAL(20,10),
        status VARCHAR(50) DEFAULT 'pending',
        plan VARCHAR(50),
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "payments" ready');

    // Create user_models table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_models (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        model_username VARCHAR(255) NOT NULL,
        display_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        is_deleted BOOLEAN DEFAULT FALSE,
        deleted_at TIMESTAMP,
        UNIQUE(user_id, model_username)
      );
    `);
    console.log('✅ Table "user_models" ready');

    // Add is_deleted column if not exists (migration)
    try {
      await pool.query(`ALTER TABLE user_models ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE`);
      console.log('✅ Added column: is_deleted to user_models');
    } catch (err) {
      if (err.code === '42701') {
        console.log('ℹ️ Column is_deleted already exists');
      }
    }

    try {
      await pool.query(`ALTER TABLE user_models ADD COLUMN deleted_at TIMESTAMP`);
      console.log('✅ Added column: deleted_at to user_models');
    } catch (err) {
      if (err.code === '42701') {
        console.log('ℹ️ Column deleted_at already exists');
      }
    }

    // Create model_fans_history table (global - shared between all users)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS model_fans_history (
        id SERIAL PRIMARY KEY,
        model_username VARCHAR(255) NOT NULL,
        fans_count INTEGER,
        fans_text VARCHAR(50),
        recorded_at TIMESTAMP DEFAULT NOW(),
        recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
    `);
    console.log('✅ Table "model_fans_history" ready');

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
      CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
      CREATE INDEX IF NOT EXISTS idx_user_models_user_id ON user_models(user_id);
      CREATE INDEX IF NOT EXISTS idx_model_fans_username ON model_fans_history(model_username);
      CREATE INDEX IF NOT EXISTS idx_model_fans_latest ON model_fans_history(model_username, recorded_at DESC);
    `);
    console.log('✅ Indexes created');

    console.log('🎉 Database initialization complete!');
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
};

// Run if executed directly
if (require.main === module) {
  initDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = initDatabase;
