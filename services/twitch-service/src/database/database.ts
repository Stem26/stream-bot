import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

// Корень монорепо (все данные в корне: *.json, *.db)
const MONOREPO_ROOT = (() => {
  const cwd = process.cwd();
  // Уже в корне проекта (есть папка services)
  if (fs.existsSync(path.join(cwd, 'services')) && fs.existsSync(path.join(cwd, 'package.json'))) {
    return cwd;
  }
  // В services/xxx — поднимаемся в корень
  const projectRoot = path.resolve(cwd, '..', '..');
  if (fs.existsSync(path.join(projectRoot, 'services')) && fs.existsSync(path.join(projectRoot, 'package.json'))) {
    return projectRoot;
  }
  return cwd;
})();

export const DB_PATH = process.env.TEST_DB_PATH || path.join(MONOREPO_ROOT, 'twitch-bot.db');

let db: Database.Database | null = null;

/**
 * Получить экземпляр базы данных
 */
export function getDatabase(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL'); // Режим WAL для лучшей производительности
    db.pragma('foreign_keys = ON'); // Включаем внешние ключи
    console.log(`[DATABASE] Подключение к БД: ${DB_PATH}`);
  }
  return db;
}

/**
 * Закрыть подключение к базе данных
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log('[DATABASE] Подключение к БД закрыто');
  }
}

/**
 * Инициализировать базу данных (создать таблицы)
 */
export function initDatabase(): void {
  const database = getDatabase();

  // twitch_player_stats: twitch_username как PK (таблица twitch_users удалена)
  const tuExists = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='twitch_users'").get();
  const tpsExists = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='twitch_player_stats'").get();

  if (tuExists && tpsExists) {
    const cols = database.prepare('PRAGMA table_info(twitch_player_stats)').all() as { name: string }[];
    const hasUserId = cols.some((c) => c.name === 'user_id');
    if (hasUserId) {
      console.log('[DATABASE] Миграция: удаляем twitch_users, переводим twitch_player_stats на twitch_username...');
      database.exec(`
        CREATE TABLE twitch_player_stats_new (
          twitch_username TEXT PRIMARY KEY NOT NULL,
          size INTEGER DEFAULT 0,
          last_used INTEGER,
          last_used_date TEXT,
          points INTEGER DEFAULT 1000,
          duel_timeout_until INTEGER,
          duel_cooldown_until INTEGER,
          duel_wins INTEGER DEFAULT 0,
          duel_losses INTEGER DEFAULT 0,
          duel_draws INTEGER DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO twitch_player_stats_new (twitch_username, size, last_used, last_used_date, points, duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws, updated_at)
        SELECT LOWER(COALESCE(tps.twitch_username, tu.twitch_username)), tps.size, tps.last_used, tps.last_used_date, tps.points,
          tps.duel_timeout_until, tps.duel_cooldown_until, tps.duel_wins, tps.duel_losses, tps.duel_draws, tps.updated_at
        FROM twitch_player_stats tps JOIN twitch_users tu ON tps.user_id = tu.id;
        DROP TABLE twitch_player_stats;
        DROP TABLE twitch_users;
        ALTER TABLE twitch_player_stats_new RENAME TO twitch_player_stats;
      `);
      console.log('[DATABASE] Миграция завершена');
    } else {
      database.exec('DROP TABLE IF EXISTS twitch_users');
    }
  } else if (tuExists) {
    database.exec('DROP TABLE twitch_users');
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS twitch_player_stats (
      twitch_username TEXT PRIMARY KEY NOT NULL,
      size INTEGER DEFAULT 0,
      last_used INTEGER,
      last_used_date TEXT,
      points INTEGER DEFAULT 1000,
      duel_timeout_until INTEGER,
      duel_cooldown_until INTEGER,
      duel_wins INTEGER DEFAULT 0,
      duel_losses INTEGER DEFAULT 0,
      duel_draws INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Таблица истории стримов (без game, title, created_at/updated_at — дата стрима в stream_date)
  const shExists = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_history'").get();
  if (shExists) {
    const shCols = database.prepare('PRAGMA table_info(stream_history)').all() as { name: string }[];
    const hasGame = shCols.some((c) => c.name === 'game');
    const hasTitle = shCols.some((c) => c.name === 'title');
    const hasUpdatedAt = shCols.some((c) => c.name === 'updated_at');
    const hasCreatedAt = shCols.some((c) => c.name === 'created_at');
    if (hasGame || hasTitle || hasUpdatedAt || hasCreatedAt) {
      console.log('[DATABASE] Миграция stream_history: убираем game, title, created_at, updated_at...');
      database.exec(`
        CREATE TABLE stream_history_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stream_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          duration TEXT NOT NULL,
          peak_viewers INTEGER DEFAULT 0,
          follows_count INTEGER DEFAULT 0
        );
        INSERT INTO stream_history_new (id, stream_date, start_time, duration, peak_viewers, follows_count)
        SELECT id, stream_date, start_time, duration, peak_viewers, follows_count FROM stream_history;
        DROP TABLE stream_history;
        ALTER TABLE stream_history_new RENAME TO stream_history;
      `);
      console.log('[DATABASE] Миграция stream_history завершена');
    }
  } else {
    database.exec(`
      CREATE TABLE stream_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        duration TEXT NOT NULL,
        peak_viewers INTEGER DEFAULT 0,
        follows_count INTEGER DEFAULT 0
      )
    `);
  }

  // Миграция: убрать created_at (только для twitch_player_stats)
  for (const table of ['twitch_player_stats']) {
    const tableCols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const hasCreatedAt = tableCols.some((c) => c.name === 'created_at');
    const hasUpdatedAt = tableCols.some((c) => c.name === 'updated_at');
    if (hasCreatedAt) {
      try {
        if (!hasUpdatedAt) {
          database.exec(`ALTER TABLE ${table} ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
          database.exec(`UPDATE ${table} SET updated_at = created_at WHERE updated_at IS NULL`);
        }
        database.exec(`ALTER TABLE ${table} DROP COLUMN created_at`);
        console.log(`[DATABASE] Удалена колонка created_at из ${table}`);
      } catch { /* SQLite < 3.35 */ }
    }
  }

  // Индексы для ускорения запросов
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_twitch_player_stats_username ON twitch_player_stats(twitch_username);
    CREATE INDEX IF NOT EXISTS idx_twitch_player_stats_size ON twitch_player_stats(size DESC);
    CREATE INDEX IF NOT EXISTS idx_twitch_player_stats_points ON twitch_player_stats(points DESC);
    CREATE INDEX IF NOT EXISTS idx_twitch_player_stats_last_used ON twitch_player_stats(last_used_date);
    CREATE INDEX IF NOT EXISTS idx_stream_history_date ON stream_history(stream_date DESC);
  `);

  console.log('[DATABASE] Таблицы Twitch бота созданы');
}
