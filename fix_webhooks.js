const fs = require('fs');
let content = fs.readFileSync('src/routes/webhooks.js', 'utf8');

const oldCode = `      // Use UPSERT to ensure only ONE subscription record per user
      // This prevents race conditions from duplicate webhooks
      const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // +30 days from now

      const result = await query(\`
        INSERT INTO subscriptions (
          user_id, plan, model_limit, status, payment_provider, payment_id,
          starts_at, expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 'active', 'nowpayments', $4, NOW(), $5, NOW(), NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          plan = EXCLUDED.plan,
          model_limit = EXCLUDED.model_limit,
          status = 'active',
          payment_provider = 'nowpayments',
          payment_id = EXCLUDED.payment_id,
          starts_at = NOW(),
          expires_at = CASE
            WHEN subscriptions.status = 'active' AND subscriptions.expires_at > NOW()
            THEN subscriptions.expires_at + INTERVAL '30 days'
            ELSE EXCLUDED.expires_at
          END,
          updated_at = NOW()
        RETURNING (xmax = 0) as is_insert
      \`, [payment.user_id, payment.plan, planConfig.modelLimit, payment_id, newExpiry]);

      const wasInsert = result.rows[0]?.is_insert;

      // Clear models only on new subscription (not extension)
      // Check if previous was not active
      if (wasInsert) {
        await query(\`DELETE FROM user_models WHERE user_id = $1\`, [payment.user_id]);
        console.log(\`Cleared models for user \${payment.user_id} (first subscription)\`);
      }`;

const newCode = `      // Check if user has existing subscription
      const existingSub = await getOne(
        'SELECT id, status, expires_at FROM subscriptions WHERE user_id = $1',
        [payment.user_id]
      );

      const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // +30 days

      if (existingSub) {
        // Update existing subscription
        const currentExpiry = new Date(existingSub.expires_at);
        const now = new Date();
        const finalExpiry = (existingSub.status === 'active' && currentExpiry > now)
          ? new Date(currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000)
          : newExpiry;

        await query(\`
          UPDATE subscriptions SET plan = $1, model_limit = $2, status = 'active',
            payment_provider = 'nowpayments', payment_id = $3,
            starts_at = NOW(), expires_at = $4, updated_at = NOW()
          WHERE id = $5
        \`, [payment.plan, planConfig.modelLimit, payment_id, finalExpiry, existingSub.id]);

        if (existingSub.status !== 'active' || currentExpiry <= now) {
          await query(\`DELETE FROM user_models WHERE user_id = $1\`, [payment.user_id]);
          console.log(\`Cleared models for user \${payment.user_id} (new period)\`);
        }
        console.log(\`Updated subscription for user \${payment.user_id}\`);
      } else {
        // Create NEW subscription record
        await query(\`
          INSERT INTO subscriptions (user_id, plan, model_limit, status, payment_provider, payment_id, starts_at, expires_at, created_at, updated_at)
          VALUES ($1, $2, $3, 'active', 'nowpayments', $4, NOW(), $5, NOW(), NOW())
        \`, [payment.user_id, payment.plan, planConfig.modelLimit, payment_id, newExpiry]);

        await query(\`DELETE FROM user_models WHERE user_id = $1\`, [payment.user_id]);
        console.log(\`Created new subscription for user \${payment.user_id}\`);
      }`;

content = content.replace(oldCode, newCode);
fs.writeFileSync('src/routes/webhooks.js', content);
console.log('Done! File updated.');
