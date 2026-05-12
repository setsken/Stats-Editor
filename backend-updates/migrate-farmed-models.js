// Migrate farmed_models from local SQLite to Railway PostgreSQL
// Usage: node migrate-farmed-models.js
// Requires: DATABASE_URL env var or hardcoded connection string

const Database = require('better-sqlite3');
const { Pool } = require('pg');

// Config
const SQLITE_PATH = process.argv[2] || 'C:\\Softs\\Softs\\Comenter\\Comenter\\data\\farmed_models.db';
const DATABASE_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 500;

if (!DATABASE_URL) {
  console.error('ERROR: Set DATABASE_URL environment variable');
  console.error('Usage: DATABASE_URL=postgresql://... node migrate-farmed-models.js [path-to-sqlite]');
  process.exit(1);
}

async function migrate() {
  // Open SQLite
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  console.log(`Opened SQLite: ${SQLITE_PATH}`);

  const totalRows = sqlite.prepare('SELECT COUNT(*) as c FROM farmed_models').get().c;
  console.log(`Total rows to migrate: ${totalRows}`);

  // Connect to PostgreSQL
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  console.log('Connected to PostgreSQL');

  try {
    // Create table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS farmed_models (
        username VARCHAR(255) PRIMARY KEY,
        of_url TEXT NOT NULL,
        found_at TIMESTAMP,
        status VARCHAR(20) DEFAULT NULL
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_farmed_models_status ON farmed_models(status)');
    console.log('Table ensured');

    // Migrate in batches
    const stmt = sqlite.prepare('SELECT * FROM farmed_models LIMIT ? OFFSET ?');
    let offset = 0;
    let migrated = 0;

    while (offset < totalRows) {
      const rows = stmt.all(BATCH_SIZE, offset);
      if (rows.length === 0) break;

      // Build batch insert
      const values = [];
      const placeholders = [];

      rows.forEach((row, idx) => {
        const base = idx * 4;
        placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        values.push(
          row.username,
          row.of_url,
          row.found_at || null,
          row.status || null
        );
      });

      await client.query(
        `INSERT INTO farmed_models (username, of_url, found_at, status)
         VALUES ${placeholders.join(',')}
         ON CONFLICT (username)
         DO UPDATE SET status = EXCLUDED.status, found_at = EXCLUDED.found_at`,
        values
      );

      migrated += rows.length;
      offset += BATCH_SIZE;
      process.stdout.write(`\rMigrated: ${migrated}/${totalRows} (${Math.round(migrated / totalRows * 100)}%)`);
    }

    console.log('\nMigration complete!');

    // Verify
    const pgCount = await client.query('SELECT COUNT(*) as c FROM farmed_models');
    console.log(`PostgreSQL rows: ${pgCount.rows[0].c}`);
    const pgStats = await client.query("SELECT status, COUNT(*) as cnt FROM farmed_models GROUP BY status");
    console.log('Status distribution:');
    pgStats.rows.forEach(r => console.log(`  ${r.status || 'NULL'}: ${r.cnt}`));

  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
