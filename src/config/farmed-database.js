// Separate PostgreSQL connection pool for farmed_models (Postgres-yo-b)
const { Pool } = require('pg');

const farmedPool = new Pool({
  connectionString: process.env.FARMED_DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

farmedPool.on('connect', () => {
  console.log('Connected to Farmed Models database (Postgres-yo-b)');
});

farmedPool.on('error', (err) => {
  console.error('Farmed Models DB pool error:', err);
});

async function farmedQuery(text, params) {
  const result = await farmedPool.query(text, params);
  return result;
}

async function farmedGetOne(text, params) {
  const result = await farmedQuery(text, params);
  return result.rows[0] || null;
}

// Create farmed_models table on startup
async function initFarmedDatabase() {
  try {
    await farmedQuery(`
      CREATE TABLE IF NOT EXISTS farmed_models (
        username VARCHAR(255) PRIMARY KEY,
        of_url TEXT NOT NULL,
        found_at TIMESTAMP,
        status VARCHAR(20) DEFAULT NULL
      )
    `);
    await farmedQuery('CREATE INDEX IF NOT EXISTS idx_farmed_models_status ON farmed_models(status)');
    console.log('Farmed Models database initialized');
  } catch (error) {
    console.error('Farmed Models DB init error:', error);
  }
}

module.exports = { farmedPool, farmedQuery, farmedGetOne, initFarmedDatabase };
