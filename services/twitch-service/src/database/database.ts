import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

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

const DATABASE_URL = process.env.TWITCH_DATABASE_URL || process.env.DATABASE_URL;

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    if (!DATABASE_URL) {
      console.log('⚠️ [DATABASE] DATABASE_URL не задан, создаём заглушку');
      // Создаём пустой pool для dev режима (не будет использоваться)
      pool = new Pool({ connectionString: 'postgresql://localhost:5432/dev_stub' });
    } else {
      pool = new Pool({ connectionString: DATABASE_URL });
      console.log('[DATABASE] Подключение к PostgreSQL (Twitch)');
    }
  }
  return pool;
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[DATABASE] Подключение к БД закрыто');
  }
}

export async function initDatabase(): Promise<void> {
  // Для локальной разработки без БД
  if (!DATABASE_URL) {
    console.log('⚠️ [DATABASE] DATABASE_URL не задан, работаем без БД (dev mode)');
    return;
  }

  try {
    const client = await getPool().connect();

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS twitch_player_stats (
          twitch_username TEXT PRIMARY KEY,
          size INTEGER DEFAULT 0,
          last_used BIGINT,
          last_used_date TEXT,
          points INTEGER DEFAULT 1000,
          duel_timeout_until BIGINT,
          duel_cooldown_until BIGINT,
          duel_wins INTEGER DEFAULT 0,
          duel_losses INTEGER DEFAULT 0,
          duel_draws INTEGER DEFAULT 0,
          -- ежедневная активность дуэлей
          duels_today INTEGER DEFAULT 0,
          last_duel_date TEXT,
          last_daily_quest_reward_date TEXT,
          -- серия побед в дуэлях
          duel_win_streak INTEGER DEFAULT 0,
          streak_reward_active BOOLEAN DEFAULT FALSE,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Добавляем недостающие колонки для уже существующих БД
      await client.query(
        `ALTER TABLE twitch_player_stats
         ADD COLUMN IF NOT EXISTS duels_today INTEGER DEFAULT 0`
      );
      await client.query(
        `ALTER TABLE twitch_player_stats
         ADD COLUMN IF NOT EXISTS last_duel_date TEXT`
      );
      await client.query(
        `ALTER TABLE twitch_player_stats
         ADD COLUMN IF NOT EXISTS last_daily_quest_reward_date TEXT`
      );
      await client.query(
        `ALTER TABLE twitch_player_stats
         ADD COLUMN IF NOT EXISTS duel_win_streak INTEGER DEFAULT 0`
      );
      await client.query(
        `ALTER TABLE twitch_player_stats
         ADD COLUMN IF NOT EXISTS streak_reward_active BOOLEAN DEFAULT FALSE`
      );

      await client.query(`
        CREATE TABLE IF NOT EXISTS stream_history (
          id SERIAL PRIMARY KEY,
          stream_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          duration TEXT NOT NULL,
          peak_viewers INTEGER DEFAULT 0,
          follows_count INTEGER DEFAULT 0
        )
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_twitch_player_stats_size ON twitch_player_stats(size DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_twitch_player_stats_points ON twitch_player_stats(points DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_twitch_player_stats_last_used ON twitch_player_stats(last_used_date)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_stream_history_date ON stream_history(stream_date DESC)`);

      console.log('[DATABASE] Таблицы Twitch бота созданы');
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('⚠️ [DATABASE] Ошибка подключения, продолжаем без БД:', error);
  }
}
