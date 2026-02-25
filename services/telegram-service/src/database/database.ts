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

export const DB_PATH = process.env.TEST_DB_PATH || path.join(MONOREPO_ROOT, 'telegram-bot.db');

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

  // player_stats: telegram_id как PK (таблица users удалена)
  const usersExists = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  const psExists = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='player_stats'").get();

  if (usersExists && psExists) {
    const cols = database.prepare('PRAGMA table_info(player_stats)').all() as { name: string }[];
    const hasUserId = cols.some((c) => c.name === 'user_id');
    const hasTelegramId = cols.some((c) => c.name === 'telegram_id');
    if (hasUserId && !hasTelegramId) {
      console.log('[DATABASE] Миграция: удаляем users, переводим player_stats на telegram_id...');
      database.exec(`
        CREATE TABLE player_stats_new (
          telegram_id INTEGER PRIMARY KEY NOT NULL,
          username TEXT,
          first_name TEXT,
          size INTEGER DEFAULT 0,
          last_used INTEGER,
          last_used_date TEXT,
          last_horny_date TEXT,
          last_furry_date TEXT,
          last_future_date TEXT,
          future_attempts_today INTEGER DEFAULT 0,
          last_growth INTEGER DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO player_stats_new SELECT u.telegram_id, COALESCE(ps.username,u.username), COALESCE(ps.first_name,u.first_name),
          ps.size, ps.last_used, ps.last_used_date, ps.last_horny_date, ps.last_furry_date, ps.last_future_date,
          COALESCE(ps.future_attempts_today,0), COALESCE(ps.last_growth,0), ps.updated_at
        FROM player_stats ps JOIN users u ON ps.user_id = u.id;
        DROP TABLE player_stats;
        DROP TABLE users;
        ALTER TABLE player_stats_new RENAME TO player_stats;
      `);
      console.log('[DATABASE] Миграция завершена');
    } else {
      database.exec('DROP TABLE IF EXISTS users');
    }
  } else if (usersExists) {
    database.exec('DROP TABLE users');
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS player_stats (
      telegram_id INTEGER PRIMARY KEY NOT NULL,
      username TEXT,
      first_name TEXT,
      size INTEGER DEFAULT 0,
      last_used INTEGER,
      last_used_date TEXT,
      last_horny_date TEXT,
      last_furry_date TEXT,
      last_future_date TEXT,
      future_attempts_today INTEGER DEFAULT 0,
      last_growth INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Миграция: убрать created_at
  const tableCols = database.prepare('PRAGMA table_info(player_stats)').all() as { name: string }[];
  if (tableCols.some((c) => c.name === 'created_at')) {
    try { database.exec('ALTER TABLE player_stats DROP COLUMN created_at'); } catch { /* ignore */ }
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_player_stats_size ON player_stats(size DESC);
    CREATE INDEX IF NOT EXISTS idx_player_stats_last_used ON player_stats(last_used_date);
  `);

  console.log('[DATABASE] Таблицы Telegram бота созданы');
}
