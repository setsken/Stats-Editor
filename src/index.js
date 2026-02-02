// Build: 2026-02-02 03:30:00
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { query } = require('./config/database');

// Import routes
const authRoutes = require('./routes/auth');
const subscriptionRoutes = require('./routes/subscription');
const modelsRoutes = require('./routes/models');
const fansRoutes = require('./routes/fans');
const webhooksRoutes = require('./routes/webhooks');

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
    version: '1.0.0',
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
