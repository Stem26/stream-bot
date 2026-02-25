#!/usr/bin/env node
/**
 * Проверка БД (PostgreSQL)
 * Запуск: node scripts/db-check.js
 * Требует DATABASE_URL или TELEGRAM_DATABASE_URL и TWITCH_DATABASE_URL в .env
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');

async function checkDb(connectionString, name, queries) {
  if (!connectionString) {
    console.log(`\n⏭️ ${name}: DATABASE_URL не задан, пропускаем`);
    return;
  }
  const pool = new Pool({ connectionString });
  try {
    console.log(`\n📊 ${name}:`);
    for (const [label, sql] of queries) {
      const res = await pool.query(sql);
      const val = res.rows[0] ? Object.values(res.rows[0])[0] : 0;
      console.log(`   ${label}: ${val}`);
    }
  } catch (e) {
    console.log(`\n❌ ${name}: ${e.message}`);
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log('🔍 Проверка баз данных...');
  const telegramUrl = process.env.TELEGRAM_DATABASE_URL || process.env.DATABASE_URL;
  const twitchUrl = process.env.TWITCH_DATABASE_URL || process.env.DATABASE_URL;

  await checkDb(telegramUrl, 'Telegram (player_stats)', [
    ['Игроков', 'SELECT COUNT(*) as c FROM player_stats']
  ]);

  await checkDb(twitchUrl, 'Twitch (twitch_player_stats)', [
    ['Игроков', 'SELECT COUNT(*) as c FROM twitch_player_stats'],
    ['Записей stream_history', 'SELECT COUNT(*) as c FROM stream_history']
  ]);

  console.log('\n✅ Готово\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
