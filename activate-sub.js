const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:BxRxyOnhXIEWpvMjOlIjVhQRRCKgYsud@hopper.proxy.rlwy.net:20853/railway',
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    // Update payment status
    await pool.query("UPDATE payments SET status = 'completed' WHERE id = 17");
    console.log('Payment updated to completed');
    
    // Update subscription
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    
    await pool.query(
      "UPDATE subscriptions SET plan = 'plus', status = 'active', model_limit = 10, expires_at = $1 WHERE user_id = 20",
      [expiresAt]
    );
    console.log('Subscription activated until:', expiresAt);
    
    // Verify
    const sub = await pool.query('SELECT plan, status, expires_at FROM subscriptions WHERE user_id = 20');
    console.log('Result:', sub.rows[0]);
    
  } catch (e) {
    console.error('Error:', e.message);
  }
  
  await pool.end();
})();
