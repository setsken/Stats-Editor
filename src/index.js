// Build: 2026-04-07 12:00:00
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { query } = require('./config/database');

// Import routes
// Phase 7a (SE/PS split, 2026-05-23): /fans, /farmed-models, /alerts, /notes,
// /verdict moved to Profile-Stats backend. Their handlers + the shared
// farmed-database connection have been deleted here.
const authRoutes = require('./routes/auth');
const subscriptionRoutes = require('./routes/subscription');
const modelsRoutes = require('./routes/models');
const webhooksRoutes = require('./routes/webhooks');
const promoRoutes = require('./routes/promo');
const presetsRoutes = require('./routes/presets');

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

    // NOTE (Phase 7a, 2026-05-23): CREATE TABLE statements for
    // model_fans_daily, model_quality_snapshots, model_alerts, user_notes
    // and user_tags removed — these belong to Profile-Stats and live in
    // its own postgres-yo-b instance. The old duplicate tables in this
    // (SE) DB are now orphans, scheduled for DROP TABLE in a separate
    // task after we've monitored that no writes still hit them.

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

    console.log('✅ Migrations completed');
  } catch (error) {
    console.log('⚠️ Migration skipped or already applied');
  }
}
runMigrations();

// Trust proxy for Railway (required for express-rate-limit)
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// Auto-detect APP_URL on Railway
const APP_URL = process.env.APP_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);
process.env.APP_URL = APP_URL; // Make it available to other modules

// Two base URLs, deliberately kept apart — they have different failure modes.
//
// PUBLIC_URL — links a *user's browser* opens (the payment result pages).
// Should point at the Cloudflare-proxied domain: some ISPs block Railway's IP
// range outright (confirmed with a UA user in Aug 2026), and those users would
// otherwise land on a dead page immediately after paying.
//
// ORIGIN_URL — server-to-server callbacks (the NOWPayments IPN). Stays on the
// Railway origin on purpose: this is the request that activates a paid
// subscription, so it must not depend on a proxy in front of us being up.
// NOWPayments' servers are not affected by any end-user ISP blocking.
const PUBLIC_URL = process.env.PUBLIC_URL || APP_URL;
const ORIGIN_URL = process.env.ORIGIN_URL || APP_URL;
process.env.PUBLIC_URL = PUBLIC_URL;
process.env.ORIGIN_URL = ORIGIN_URL;

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

// Payment result pages — NOWPayments sends the buyer's browser here after
// checkout. Before this existed both URLs fell through to the JSON 404 handler,
// so everyone who paid landed on {"error":"Endpoint not found"} — which reads
// like a failed payment and invites a second one.
app.get('/payment/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'payment-success.html'));
});

app.get('/payment/cancel', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'payment-cancel.html'));
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/models', modelsRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/promo', promoRoutes);
app.use('/api/presets', presetsRoutes);

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
