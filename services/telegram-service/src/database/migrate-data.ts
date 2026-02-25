import { initDatabase, getDatabase, closeDatabase } from './database';
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

// Корень сервиса (services/telegram-service)
const SERVICE_ROOT = (() => {
  let root = process.cwd();
  if (fs.existsSync(path.join(root, 'package.json'))) {
    return root;
  }
  root = path.resolve(process.cwd(), '../..');
  if (fs.existsSync(path.join(root, 'package.json'))) {
    return root;
  }
  return process.cwd();
})();

// Корень монорепо (где лежат players.json, twitch-players.json, stream-history.json)
const MONOREPO_ROOT = path.resolve(SERVICE_ROOT, '..', '..');

const PLAYERS_JSON = path.join(MONOREPO_ROOT, 'players.json');

// Флаг --force: полная перезапись (очистить БД и импортировать заново)
const FORCE_MODE = process.argv.includes('--force');

/**
 * Скрипт для миграции данных из players.json в SQLite
 */
async function migrateData() {
  console.log('🚀 Запуск миграции данных из JSON в SQLite...');
  console.log(`📁 Путь к JSON: ${PLAYERS_JSON}`);
  if (FORCE_MODE) {
    console.log('⚡ Режим --force: полная перезапись данных');
  }

  // Проверяем наличие JSON файла
  if (!fs.existsSync(PLAYERS_JSON)) {
    console.log('⚠️  JSON файл не найден, миграция не требуется');
    return;
  }

  try {
    // Инициализируем БД
    initDatabase();
    const db = getDatabase();

    // Читаем JSON файл
    const jsonData = fs.readFileSync(PLAYERS_JSON, 'utf-8');
    const playersObject = JSON.parse(jsonData);
    
    // Конвертируем объект в массив
    const playersArray: PlayerData[] = Object.values(playersObject);

    console.log(`📊 Найдено игроков в JSON: ${playersArray.length}`);

    let migratedCount = 0;
    let skippedCount = 0;

    const transaction = db.transaction(() => {
      if (FORCE_MODE) {
        db.prepare('DELETE FROM player_stats').run();
      }

      for (const player of playersArray) {
        if (!FORCE_MODE) {
          const existing = db.prepare('SELECT telegram_id FROM player_stats WHERE telegram_id = ?').get(player.userId);
          if (existing) {
            console.log(`⏭️  Пропускаем ${player.username} (уже существует)`);
            skippedCount++;
            continue;
          }
        }

        db.prepare(`
          INSERT INTO player_stats (telegram_id, username, first_name, size, last_used, last_used_date,
            last_horny_date, last_furry_date, last_future_date, future_attempts_today, last_growth)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          player.userId,
          player.username,
          player.firstName,
          player.size,
          player.lastUsed,
          player.lastUsedDate || null,
          player.lastHornyDate || null,
          player.lastFurryDate || null,
          player.lastFutureDate || null,
          player.futureAttemptsToday || 0,
          player.lastGrowth || 0
        );

        migratedCount++;
        console.log(`✅ Мигрирован: ${player.username}`);
      }
    });

    transaction();

    console.log('\n📈 Результаты миграции:');
    console.log(`   ✅ Мигрировано: ${migratedCount}`);
    console.log(`   ⏭️  Пропущено: ${skippedCount}`);
    console.log(`   📊 Всего: ${playersArray.length}`);

    // Создаём резервную копию JSON файла
    const backupPath = PLAYERS_JSON + '.backup';
    fs.copyFileSync(PLAYERS_JSON, backupPath);
    console.log(`\n💾 Создана резервная копия: ${backupPath}`);
    console.log('ℹ️  Старый JSON файл можно удалить после проверки работы БД');

    closeDatabase();
    console.log('\n✅ Миграция успешно завершена!');
  } catch (error) {
    console.error('❌ Ошибка при миграции:', error);
    closeDatabase();
    process.exit(1);
  }
}

migrateData();
