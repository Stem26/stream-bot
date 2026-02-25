import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Загрузка .env из корня монорепо
const MONOREPO_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'services')) && fs.existsSync(path.join(cwd, 'package.json'))) {
    return cwd;
  }
  const projectRoot = path.resolve(cwd, '..', '..');
  if (fs.existsSync(path.join(projectRoot, 'services')) && fs.existsSync(path.join(projectRoot, 'package.json'))) {
    return projectRoot;
  }
  return cwd;
})();

const envFile = process.env.NODE_ENV === 'development' ? '.env.local' : '.env';
dotenv.config({ path: path.join(MONOREPO_ROOT, envFile) });

const DATABASE_URL = process.env.DATABASE_URL || process.env.TELEGRAM_DATABASE_URL;

let pool: Pool | null = null;

/**
 * Получить пул подключений
 */
export function getPool(): Pool {
  if (!pool) {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL или TELEGRAM_DATABASE_URL не задан в .env');
    }
    pool = new Pool({ connectionString: DATABASE_URL });
    console.log('[DATABASE] Подключение к PostgreSQL (Telegram)');
  }
  return pool;
}

/**
 * Выполнить запрос (удобная обёртка)
 */
export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

/**
 * Выполнить запрос и вернуть одну строку
 */
export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Закрыть пул
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[DATABASE] Подключение к БД закрыто');
  }
}

/**
 * Инициализировать базу данных (создать таблицы)
 */
export async function initDatabase(): Promise<void> {
  const client = await getPool().connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS player_stats (
        telegram_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        size INTEGER DEFAULT 0,
        last_used BIGINT,
        last_used_date TEXT,
        last_horny_date TEXT,
        last_furry_date TEXT,
        last_future_date TEXT,
        future_attempts_today INTEGER DEFAULT 0,
        last_growth INTEGER DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_player_stats_size ON player_stats(size DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_player_stats_last_used ON player_stats(last_used_date)
    `);

    console.log('[DATABASE] Таблицы Telegram бота созданы');
  } finally {
    client.release();
  }
}
