import { initDatabase, getDatabase, closeDatabase } from './database';
import * as fs from 'fs';
import * as path from 'path';

interface TwitchPlayerData {
  twitchUsername: string;
  size: number;
  lastUsed: number;
  lastUsedDate?: string;
  points?: number;
  duelTimeoutUntil?: number;
  duelCooldownUntil?: number;
  duelWins?: number;
  duelLosses?: number;
  duelDraws?: number;
}

interface StreamHistoryEntry {
  date: string;
  startTime: string;
  duration: string;
  peakViewers: number;
  followsCount?: number;
}

// Корень сервиса (services/twitch-service)
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

// Корень монорепо (где лежат players.json, stream-history.json)
const MONOREPO_ROOT = path.resolve(SERVICE_ROOT, '..', '..');

const TWITCH_PLAYERS_JSON = path.join(MONOREPO_ROOT, 'twitch-players.json');
const STREAM_HISTORY_JSON = path.join(MONOREPO_ROOT, 'stream-history.json');

// Флаг --force: полная перезапись (очистить БД и импортировать заново)
const FORCE_MODE = process.argv.includes('--force');

/**
 * Мигрирует данные Twitch игроков
 */
function migrateTwitchPlayers(db: any): number {
  if (!fs.existsSync(TWITCH_PLAYERS_JSON)) {
    console.log('⚠️  twitch-players.json не найден, пропускаем');
    return 0;
  }

  const jsonData = fs.readFileSync(TWITCH_PLAYERS_JSON, 'utf-8');
  const playersArray: TwitchPlayerData[] = JSON.parse(jsonData);

  console.log(`\n📊 Найдено Twitch игроков: ${playersArray.length}`);
  if (FORCE_MODE) {
    console.log('🔄 Режим --force: очищаем старые данные и импортируем заново');
  }

  let migratedCount = 0;

  const transaction = db.transaction(() => {
    if (FORCE_MODE) {
      db.prepare('DELETE FROM twitch_player_stats').run();
    }

    for (const player of playersArray) {
      const norm = player.twitchUsername.toLowerCase();

      if (!FORCE_MODE) {
        const existing = db.prepare('SELECT twitch_username FROM twitch_player_stats WHERE twitch_username = ?').get(norm);
        if (existing) {
          console.log(`⏭️  Пропускаем ${player.twitchUsername} (уже существует)`);
          continue;
        }
      }

      db.prepare(`
        INSERT INTO twitch_player_stats (twitch_username, size, last_used, last_used_date, points,
          duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        norm,
        player.size,
        player.lastUsed,
        player.lastUsedDate || null,
        player.points || 1000,
        player.duelTimeoutUntil || null,
        player.duelCooldownUntil || null,
        player.duelWins || 0,
        player.duelLosses || 0,
        player.duelDraws || 0
      );

      migratedCount++;
      console.log(`✅ Мигрирован: ${player.twitchUsername}`);
    }
  });

  transaction();

  // Создаём резервную копию
  const backupPath = TWITCH_PLAYERS_JSON + '.backup';
  fs.copyFileSync(TWITCH_PLAYERS_JSON, backupPath);
  console.log(`💾 Создана резервная копия: ${backupPath}`);

  return migratedCount;
}

/**
 * Мигрирует историю стримов
 */
function migrateStreamHistory(db: any): number {
  if (!fs.existsSync(STREAM_HISTORY_JSON)) {
    console.log('⚠️  stream-history.json не найден, пропускаем');
    return 0;
  }

  const jsonData = fs.readFileSync(STREAM_HISTORY_JSON, 'utf-8');
  const historyArray: StreamHistoryEntry[] = JSON.parse(jsonData);

  console.log(`\n📊 Найдено записей истории стримов: ${historyArray.length}`);

  let migratedCount = 0;

  const transaction = db.transaction(() => {
    if (FORCE_MODE) {
      db.prepare('DELETE FROM stream_history').run();
    }

    for (const entry of historyArray) {
      if (!FORCE_MODE) {
        const existing = db.prepare(`
          SELECT id FROM stream_history 
          WHERE stream_date = ? AND start_time = ?
        `).get(entry.date, entry.startTime);

        if (existing) {
          console.log(`⏭️  Пропускаем стрим ${entry.date} ${entry.startTime} (уже существует)`);
          continue;
        }
      }

      db.prepare(`
        INSERT INTO stream_history (stream_date, start_time, duration, peak_viewers, follows_count)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        entry.date,
        entry.startTime,
        entry.duration,
        entry.peakViewers,
        entry.followsCount || null
      );

      migratedCount++;
      console.log(`✅ Мигрирован стрим: ${entry.date} ${entry.startTime}`);
    }
  });

  transaction();

  // Создаём резервную копию
  const backupPath = STREAM_HISTORY_JSON + '.backup';
  fs.copyFileSync(STREAM_HISTORY_JSON, backupPath);
  console.log(`💾 Создана резервная копия: ${backupPath}`);

  return migratedCount;
}

/**
 * Главная функция миграции
 */
async function migrateData() {
  console.log('🚀 Запуск миграции данных Twitch бота из JSON в SQLite...');
  if (FORCE_MODE) {
    console.log('⚡ Режим --force: полная перезапись данных');
  }

  try {
    // Инициализируем БД
    initDatabase();
    const db = getDatabase();

    // Мигрируем Twitch игроков
    const playersCount = migrateTwitchPlayers(db);

    // Мигрируем историю стримов
    const historyCount = migrateStreamHistory(db);

    console.log('\n📈 Результаты миграции:');
    console.log(`   ✅ Twitch игроков: ${playersCount}`);
    console.log(`   ✅ Записей истории: ${historyCount}`);
    console.log(`   📊 Всего: ${playersCount + historyCount}`);

    console.log('\nℹ️  Старые JSON файлы можно удалить после проверки работы БД');

    closeDatabase();
    console.log('\n✅ Миграция успешно завершена!');
  } catch (error) {
    console.error('❌ Ошибка при миграции:', error);
    closeDatabase();
    process.exit(1);
  }
}

migrateData();
