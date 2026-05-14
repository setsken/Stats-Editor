// Build: 2026-04-07 12:00:00
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { query } = require('./config/database');
const { initFarmedDatabase } = require('./config/farmed-database');

// Import routes
const authRoutes = require('./routes/auth');
const subscriptionRoutes = require('./routes/subscription');
const modelsRoutes = require('./routes/models');
const fansRoutes = require('./routes/fans');
const webhooksRoutes = require('./routes/webhooks');
const promoRoutes = require('./routes/promo');
const presetsRoutes = require('./routes/presets');
const farmedModelsRoutes = require('./routes/farmed-models');
const alertsRoutes = require('./routes/alerts');
const notesRoutes = require('./routes/notes');
const verdictRoutes = require('./routes/verdict');

const app = express();

// Run migrations on startup
async function runMigrations() {
  try {
    // Add is_deleted column to user_models if not exists
    await query(`
      ALTER TABLE user_models ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE
    `).catch(() => {});
    
    await query(`
      ALTER TABLE user_models ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP
    `).catch(() => {});

    // Create model_fans_daily table for trend charts
    await query(`
      CREATE TABLE IF NOT EXISTS model_fans_daily (
        model_username VARCHAR(255) NOT NULL,
        day DATE NOT NULL,
        fans_count INTEGER NOT NULL,
        reporters INTEGER DEFAULT 1,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (model_username, day)
      )
    `).catch(() => {});
    await query('CREATE INDEX IF NOT EXISTS idx_model_fans_daily_username ON model_fans_daily(model_username)').catch(() => {});

    // Create model_quality_snapshots for aggregated percentile ranking
    await query(`
      CREATE TABLE IF NOT EXISTS model_quality_snapshots (
        model_username VARCHAR(255) PRIMARY KEY,
        quality_score NUMERIC(6,5) NOT NULL,
        score NUMERIC(6,2) NOT NULL,
        organicity NUMERIC(6,2) NOT NULL,
        engagement_rate NUMERIC(12,6) NOT NULL,
        negative_flags INTEGER DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await query('CREATE INDEX IF NOT EXISTS idx_model_quality_snapshots_quality ON model_quality_snapshots(quality_score)').catch(() => {});

    // Create model_alerts table for global alerts
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
    `).catch(() => {});
    await query('CREATE INDEX IF NOT EXISTS idx_model_alerts_username ON model_alerts(model_username)').catch(() => {});
    await query('CREATE INDEX IF NOT EXISTS idx_model_alerts_date ON model_alerts(alert_date)').catch(() => {});

    // Create user_notes table for cloud-synced personal notes
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
    `).catch(() => {});
    await query('CREATE INDEX IF NOT EXISTS idx_user_notes_user_id ON user_notes(user_id)').catch(() => {});
    await query('CREATE INDEX IF NOT EXISTS idx_user_notes_model ON user_notes(user_id, model_username)').catch(() => {});

    // Create user_tags table for personal note tags
    await query(`
      CREATE TABLE IF NOT EXISTS user_tags (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(50) NOT NULL,
        color_index INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `).catch(() => {});
    await query('CREATE INDEX IF NOT EXISTS idx_user_tags_user_id ON user_tags(user_id)').catch(() => {});

    // Add product column to subscriptions for multi-product split (Stats Editor / Profile Stats).
    // Pre-split rows are stamped 'stats_editor' so existing /status calls behave identically.
    await query(`
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS product VARCHAR(20) DEFAULT 'stats_editor'
    `).catch(() => {});
    await query(`UPDATE subscriptions SET product = 'stats_editor' WHERE product IS NULL`).catch(() => {});
    await query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_product
      ON subscriptions(user_id, product, status, expires_at)
    `).catch(() => {});

    // Drop the legacy single-column unique(user_id) constraint and replace
    // it with unique(user_id, product). The old constraint blocked any
    // second row per user — even with a different product — so promo apply
    // for product=profile_stats failed when the user already had a
    // stats_editor subscription. Defensive: handle both the old name and
    // any auto-generated variant by introspecting pg_constraint.
    try {
      const legacy = await query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'subscriptions'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ~* '^UNIQUE \\(user_id\\)$'
      `);
      for (const row of legacy.rows) {
        await query(`ALTER TABLE subscriptions DROP CONSTRAINT "${row.conname}"`);
        console.log(`Dropped legacy unique constraint: ${row.conname}`);
      }
    } catch (e) {
      console.warn('Legacy unique(user_id) drop skipped:', e.message);
    }
    // Create the composite unique constraint, ignoring "already exists".
    try {
      await query(`
        ALTER TABLE subscriptions
        ADD CONSTRAINT subscriptions_user_id_product_unique UNIQUE (user_id, product)
      `);
    } catch (e) {
      if (!/already exists/i.test(e.message)) {
        console.warn('subscriptions_user_id_product_unique add skipped:', e.message);
      }
    }

    // One-shot data fix: NOWPayments returns its own `product: 'api'` in the
    // payment response, which used to merge into our metadata and overwrite
    // our app product label. Webhook then INSERT'd subscriptions with
    // product='api'. We now namespace ours as `appProduct`, but the rows
    // already in the DB are still wrong — re-derive product from the plan
    // name (only 'profile_stats' plan maps to product='profile_stats').
    try {
      const r = await query(`
        UPDATE subscriptions
           SET product = CASE
             WHEN plan = 'profile_stats' THEN 'profile_stats'
             ELSE 'stats_editor'
           END
         WHERE product NOT IN ('stats_editor', 'profile_stats')
         RETURNING id, plan, product
      `);
      if (r.rows.length) {
        console.log(`Fixed ${r.rows.length} subscriptions with bad product:`, r.rows);
      }
    } catch (e) {
      console.warn('Subscription product cleanup skipped:', e.message);
    }

    // Promo codes get the same product tag so a single codes pool can serve
    // both Stats Editor and Profile Stats. Existing rows default to
    // 'stats_editor' to preserve historical behaviour. Combined with a
    // (user_id, product) uniqueness rule on application, a user can redeem
    // one code per product.
    await query(`
      ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS product VARCHAR(20) DEFAULT 'stats_editor'
    `).catch(() => {});
    await query(`UPDATE promo_codes SET product = 'stats_editor' WHERE product IS NULL`).catch(() => {});
    await query(`
      CREATE INDEX IF NOT EXISTS idx_promo_codes_product ON promo_codes(product)
    `).catch(() => {});

    // Re-sync id sequences that may have drifted behind MAX(id) — same
    // failure mode kept tripping promo apply (subscriptions / promo_code_uses
    // INSERTs). Idempotent and cheap; runs once per server start.
    for (const tbl of ['promo_codes', 'subscriptions', 'promo_code_uses', 'payments', 'user_models']) {
      try {
        await query(`
          SELECT setval(
            pg_get_serial_sequence('${tbl}', 'id'),
            COALESCE((SELECT MAX(id) FROM ${tbl}), 0) + 1,
            false
          )
        `);
      } catch (e) {
        console.warn(`${tbl} seq resync skipped:`, e.message);
      }
    }

    // Backfill model_fans_daily from model_fans_history (one-time migration)
    try {
      const check = await query('SELECT COUNT(*) as cnt FROM model_fans_daily');
      if (parseInt(check.rows[0].cnt) === 0) {
        await query(`
          INSERT INTO model_fans_daily (model_username, day, fans_count, reporters, updated_at)
          SELECT model_username, recorded_at::date as day, fans_count, 1, recorded_at
          FROM model_fans_history
          WHERE fans_count IS NOT NULL
          ON CONFLICT (model_username, day) DO NOTHING
        `);
        console.log('✅ Backfilled model_fans_daily from model_fans_history');
      }
    } catch (e) {
      console.log('⚠️ Backfill skipped:', e.message);
    }
    
    console.log('✅ Migrations completed');
  } catch (error) {
    console.log('⚠️ Migration skipped or already applied');
  }
}
runMigrations();
initFarmedDatabase();

// Trust proxy for Railway (required for express-rate-limit)
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// Auto-detect APP_URL on Railway
const APP_URL = process.env.APP_URL || 
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);
process.env.APP_URL = APP_URL; // Make it available to other modules

// Security middleware
app.use(helmet());

// CORS - allow requests from Chrome extension and OnlyFans
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    // Allow Chrome extensions
    if (origin.startsWith('chrome-extension://')) return callback(null, true);
    
    // Allow OnlyFans
    if (origin.includes('onlyfans.com')) return callback(null, true);
    
    // Allow our own domain
    if (APP_URL && origin === APP_URL) return callback(null, true);
    
    // Allow localhost for development
    if (origin.includes('localhost')) return callback(null, true);
    
    callback(null, true); // Allow all for now, tighten in production if needed
  },
  credentials: true
}));

// Rate limiting - generous limits for extension users
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

// Body parsing - raw for webhooks, json for rest
app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());

// Serve static files (logo, etc.)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'OF Stats Backend',
    version: '1.1.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/models', modelsRoutes);
app.use('/api/fans', fansRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/promo', promoRoutes);
app.use('/api/presets', presetsRoutes);
app.use('/api/farmed-models', farmedModelsRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/verdict', verdictRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({ 
    error: err.message || 'Internal server error' 
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 OF Stats Backend running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
