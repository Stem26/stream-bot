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

// Локально всегда используем .env.local, если он существует рядом с монорепой.
// На проде .env.local обычно нет, поэтому берём .env.
const localEnvPath = path.join(MONOREPO_ROOT, '.env.local');
const envFile = fs.existsSync(localEnvPath) ? '.env.local' : '.env';
dotenv.config({ path: path.join(MONOREPO_ROOT, envFile) });

// Всегда сначала пробуем TWITCH_DATABASE_URL (для Twitch-сервиса),
// иначе падаем обратно на общий DATABASE_URL (продовый fallback).
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
      // Основные таблицы Twitch бота
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

      // Таблица кастомных команд бота
      await client.query(`
        CREATE TABLE IF NOT EXISTS custom_commands (
          id TEXT PRIMARY KEY,
          trigger TEXT NOT NULL UNIQUE,
          aliases TEXT[] NOT NULL DEFAULT '{}',
          response TEXT NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          cooldown INTEGER NOT NULL DEFAULT 10,
          message_type TEXT NOT NULL DEFAULT 'announcement',
          color TEXT NOT NULL DEFAULT 'primary',
          description TEXT NOT NULL DEFAULT ''
        )
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_custom_commands_enabled ON custom_commands(enabled)`);

      console.log('[DATABASE] Таблицы Twitch бота созданы/обновлены');
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('⚠️ [DATABASE] Ошибка подключения, продолжаем без БД:', error);
  }
}
