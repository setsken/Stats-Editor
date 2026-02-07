const { Client } = require('pg');

const DATABASE_URL = 'postgresql://postgres:BxRxyOnhXIEWpvMjOlIjVhQRRCKgYsud@hopper.proxy.rlwy.net:20853/railway';

async function fixConstraint() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('✅ Подключено\n');

    // Проверяем дубликаты
    console.log('1. Проверяю дубликаты...');
    const dupes = await client.query(`
      SELECT user_id, COUNT(*) as cnt 
      FROM subscriptions 
      GROUP BY user_id 
      HAVING COUNT(*) > 1
    `);
    
    if (dupes.rows.length > 0) {
      console.log('   Найдены дубликаты, удаляю старые записи...');
      for (const row of dupes.rows) {
        await client.query(`
          DELETE FROM subscriptions 
          WHERE user_id = $1 
          AND id NOT IN (
            SELECT MAX(id) FROM subscriptions WHERE user_id = $1
          )
        `, [row.user_id]);
        console.log(`   - Удалены дубликаты для user_id=${row.user_id}`);
      }
    } else {
      console.log('   Дубликатов нет');
    }

    // Добавляем constraint
    console.log('\n2. Добавляю UNIQUE constraint...');
    try {
      await client.query(`
        ALTER TABLE subscriptions 
        ADD CONSTRAINT subscriptions_user_id_unique UNIQUE (user_id)
      `);
      console.log('   ✅ Constraint добавлен!');
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log('   ℹ️ Constraint уже существует');
      } else {
        throw e;
      }
    }

    console.log('\n✅ Готово! Попробуй применить промокод снова.');

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  } finally {
    await client.end();
  }
}

fixConstraint();
