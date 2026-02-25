import { initDatabase, getPool, closeDatabase } from './database';
import * as fs from 'fs';
import * as path from 'path';

interface PlayerData {
  userId: number;
  username: string;
  firstName: string;
  size: number;
  lastUsed: number;
  lastUsedDate?: string;
  lastHornyDate?: string;
  lastFurryDate?: string;
  lastFutureDate?: string;
  futureAttemptsToday?: number;
  lastGrowth?: number;
}

const SERVICE_ROOT = (() => {
  let root = process.cwd();
  if (fs.existsSync(path.join(root, 'package.json'))) return root;
  root = path.resolve(process.cwd(), '../..');
  if (fs.existsSync(path.join(root, 'package.json'))) return root;
  return process.cwd();
})();

const MONOREPO_ROOT = path.resolve(SERVICE_ROOT, '..', '..');
const PLAYERS_JSON = path.join(MONOREPO_ROOT, 'players.json');
const FORCE_MODE = process.argv.includes('--force');

async function migrateData() {
  console.log('🚀 Запуск миграции данных из JSON в PostgreSQL...');
  console.log(`📁 Путь к JSON: ${PLAYERS_JSON}`);
  if (FORCE_MODE) {
    console.log('⚡ Режим --force: полная перезапись данных');
  }

  if (!fs.existsSync(PLAYERS_JSON)) {
    console.log('⚠️  JSON файл не найден, миграция не требуется');
    return;
  }

  try {
    await initDatabase();
    const pool = getPool();

    const jsonData = fs.readFileSync(PLAYERS_JSON, 'utf-8');
    const playersObject = JSON.parse(jsonData);
    const playersArray: PlayerData[] = Object.values(playersObject);

    console.log(`📊 Найдено игроков в JSON: ${playersArray.length}`);

    let migratedCount = 0;
    let skippedCount = 0;

    const client = await pool.connect();
    try {
      if (FORCE_MODE) {
        await client.query('DELETE FROM player_stats');
      }

      for (const player of playersArray) {
        if (!FORCE_MODE) {
          const existingResult = await client.query(
            'SELECT telegram_id FROM player_stats WHERE telegram_id = $1',
            [player.userId]
          );
          if (existingResult.rows.length > 0) {
            console.log(`⏭️  Пропускаем ${player.username} (уже существует)`);
            skippedCount++;
            continue;
          }
        }

        await client.query(
          `INSERT INTO player_stats (telegram_id, username, first_name, size, last_used, last_used_date,
            last_horny_date, last_furry_date, last_future_date, future_attempts_today, last_growth)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            player.userId, player.username, player.firstName, player.size, player.lastUsed, player.lastUsedDate || null,
            player.lastHornyDate || null, player.lastFurryDate || null, player.lastFutureDate || null,
            player.futureAttemptsToday || 0, player.lastGrowth || 0
          ]
        );

        migratedCount++;
        console.log(`✅ Мигрирован: ${player.username}`);
      }
    } finally {
      client.release();
    }

    console.log('\n📈 Результаты миграции:');
    console.log(`   ✅ Мигрировано: ${migratedCount}`);
    console.log(`   ⏭️  Пропущено: ${skippedCount}`);
    console.log(`   📊 Всего: ${playersArray.length}`);

    const backupPath = PLAYERS_JSON + '.backup';
    fs.copyFileSync(PLAYERS_JSON, backupPath);
    console.log(`\n💾 Создана резервная копия: ${backupPath}`);
    console.log('ℹ️  Старый JSON файл можно удалить после проверки работы БД');

    await closeDatabase();
    console.log('\n✅ Миграция успешно завершена!');
  } catch (error) {
    console.error('❌ Ошибка при миграции:', error);
    await closeDatabase();
    process.exit(1);
  }
}

migrateData();
