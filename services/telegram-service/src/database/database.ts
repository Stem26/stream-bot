import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { predictions as defaultFuturePredictions } from '../utils/predictions';

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
        last_all_date TEXT,
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

    await client.query(`
      ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS last_all_date TEXT
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS telegram_future_predictions (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_telegram_future_predictions_text_norm
      ON telegram_future_predictions (LOWER(BTRIM(text)))
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_telegram_future_predictions_enabled_sort
      ON telegram_future_predictions(enabled, sort_order, id)
    `);

    const existingPredictions = await client.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM telegram_future_predictions'
    );
    const predictionCount = Number(existingPredictions.rows[0]?.count ?? 0);
    if (predictionCount === 0) {
      for (const [index, text] of defaultFuturePredictions.entries()) {
        await client.query(
          `INSERT INTO telegram_future_predictions (text, enabled, sort_order)
           SELECT $1, TRUE, $2
           WHERE NOT EXISTS (
             SELECT 1 FROM telegram_future_predictions WHERE LOWER(BTRIM(text)) = LOWER(BTRIM($1))
           )`,
          [text, index]
        );
      }
      console.log(`[DATABASE] Предсказания Telegram загружены из fallback: ${defaultFuturePredictions.length}`);
    }

    console.log('[DATABASE] Таблицы Telegram бота созданы');
  } finally {
    client.release();
  }
}
