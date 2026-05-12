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

// Get multiple rows
async function getMany(text, params) {
  const result = await query(text, params);
  return result.rows;
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

    // User presets table — stores presets per user for cloud sync
    await query(`
      CREATE TABLE IF NOT EXISTS user_presets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        preset_data JSONB NOT NULL DEFAULT '{}',
        active BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, name)
      )
    `);

    // Fans daily aggregated table — one row per model per day for trend charts
    await query(`
      CREATE TABLE IF NOT EXISTS model_fans_daily (
        model_username VARCHAR(255) NOT NULL,
        day DATE NOT NULL,
        fans_count INTEGER NOT NULL,
        reporters INTEGER DEFAULT 1,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (model_username, day)
      )
    `);

    // Farmed models table — comment status from Comenter
    await query(`
      CREATE TABLE IF NOT EXISTS farmed_models (
        username VARCHAR(255) PRIMARY KEY,
        of_url TEXT NOT NULL,
        found_at TIMESTAMP,
        status VARCHAR(20) DEFAULT NULL
      )
    `);

    // Model alerts table — global alerts visible to all users per model
    await query(`
      CREATE TABLE IF NOT EXISTS model_alerts (
        id SERIAL PRIMARY KEY,
        model_username VARCHAR(255) NOT NULL,
        alert_type VARCHAR(50) NOT NULL,
        icon VARCHAR(10),
        color VARCHAR(20),
        diff VARCHAR(50),
        pct VARCHAR(20),
        extra_data JSONB DEFAULT '{}',
        alert_date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(model_username, alert_type, alert_date)
      )
    `);

    // User notes table — personal notes per user per model
    await query(`
      CREATE TABLE IF NOT EXISTS user_notes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        model_username VARCHAR(255) NOT NULL,
        note_text TEXT DEFAULT '',
        tags JSONB DEFAULT '[]',
        note_date TIMESTAMP,
        avatar_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, model_username)
      )
    `);

    // User tags table — personal tags for notes
    await query(`
      CREATE TABLE IF NOT EXISTS user_tags (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(50) NOT NULL,
        color_index INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create indexes
    await query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await query('CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_user_models_user_id ON user_models(user_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_fans_reports_username ON fans_reports(model_username)');
    await query('CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON payments(payment_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_user_presets_user_id ON user_presets(user_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_farmed_models_status ON farmed_models(status)');
    await query('CREATE INDEX IF NOT EXISTS idx_model_fans_daily_username ON model_fans_daily(model_username)');
    await query('CREATE INDEX IF NOT EXISTS idx_model_alerts_username ON model_alerts(model_username)');
    await query('CREATE INDEX IF NOT EXISTS idx_model_alerts_date ON model_alerts(alert_date)');
    await query('CREATE INDEX IF NOT EXISTS idx_user_notes_user_id ON user_notes(user_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_user_notes_model ON user_notes(user_id, model_username)');
    await query('CREATE INDEX IF NOT EXISTS idx_user_tags_user_id ON user_tags(user_id)');

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

module.exports = { pool, query, getOne, getMany, initDatabase };
