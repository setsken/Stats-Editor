// Sync farmed_models.db changes to Railway PostgreSQL via API
// Usage: node sync-farmed-models.js
// Run periodically (e.g., via Task Scheduler) to keep Railway DB updated

const Database = require('better-sqlite3');
const https = require('https');
const http = require('http');

// Config
const SQLITE_PATH = process.argv[2] || 'C:\\Softs\\Softs\\Comenter\\Comenter\\data\\farmed_models.db';
const API_URL = process.env.SYNC_API_URL || 'https://stats-editor-production.up.railway.app/api/farmed-models/sync';
const SYNC_KEY = process.env.FARMED_SYNC_KEY;
const BATCH_SIZE = 200;

if (!SYNC_KEY) {
  console.error('ERROR: Set FARMED_SYNC_KEY environment variable');
  process.exit(1);
}

function postJSON(url, data, headers) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const body = JSON.stringify(data);

    const req = lib.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode, data: chunks });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sync() {
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  console.log(`Opened SQLite: ${SQLITE_PATH}`);

  const rows = sqlite.prepare('SELECT * FROM farmed_models').all();
  console.log(`Total models: ${rows.length}`);

  let sent = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const models = batch.map(r => ({
      username: r.username,
      of_url: r.of_url,
      found_at: r.found_at,
      status: r.status
    }));

    const result = await postJSON(API_URL, { models }, { 'x-sync-key': SYNC_KEY });

    if (result.status !== 200) {
      console.error(`Batch ${i}-${i + batch.length} failed:`, result);
      break;
    }

    sent += batch.length;
    process.stdout.write(`\rSynced: ${sent}/${rows.length} (${Math.round(sent / rows.length * 100)}%)`);
  }

  console.log('\nSync complete!');
  sqlite.close();
}

sync().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
