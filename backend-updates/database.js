const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// Query helper
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('Query executed:', { text: text.substring(0, 50), duration, rows: result.rowCount });
  return result;
}

// Get single row
async function getOne(text, params) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

// Initialize database tables
async function initDatabase() {
  try {
    // Users table
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        email_verified BOOLEAN DEFAULT false,
        password_reset_token VARCHAR(255),
        password_reset_expires TIMESTAMP,
        trial_started_at TIMESTAMP,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Add new columns if they don't exist (for existing databases)
    await query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password_reset_token') THEN
          ALTER TABLE users ADD COLUMN password_reset_token VARCHAR(255);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password_reset_expires') THEN
          ALTER TABLE users ADD COLUMN password_reset_expires TIMESTAMP;
        END IF;
      END $$;
    `);

    // Subscriptions table
    await query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        plan VARCHAR(50) NOT NULL,
        model_limit INTEGER DEFAULT 10,
        status VARCHAR(50) DEFAULT 'active',
        payment_provider VARCHAR(50),
        payment_id VARCHAR(255),
        amount DECIMAL(10, 2),
        currency VARCHAR(10),
        starts_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Update existing trial subscriptions to have model_limit = 10
    await query(`
      UPDATE subscriptions SET model_limit = 10 WHERE plan = 'trial' AND model_limit IS NULL
    `);

    // User models table
    await query(`
      CREATE TABLE IF NOT EXISTS user_models (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        model_username VARCHAR(255) NOT NULL,
        display_name VARCHAR(255),
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, model_username)
      )
    `);

    // Fans reports table
    await query(`
      CREATE TABLE IF NOT EXISTS fans_reports (
        id SERIAL PRIMARY KEY,
        model_username VARCHAR(255) NOT NULL,
        fans_count INTEGER,
        fans_text VARCHAR(50),
        reported_by INTEGER REFERENCES users(id),
        reported_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Payments table
    await query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        payment_id VARCHAR(255) UNIQUE,
        order_id VARCHAR(255),
        plan VARCHAR(50) NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        currency VARCHAR(10) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        payment_address VARCHAR(255),
        pay_currency VARCHAR(10),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create indexes
    await query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await query('CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_user_models_user_id ON user_models(user_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_fans_reports_username ON fans_reports(model_username)');
    await query('CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON payments(payment_id)');

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

module.exports = { pool, query, getOne, initDatabase };
