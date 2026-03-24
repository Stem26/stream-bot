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
          description TEXT NOT NULL DEFAULT '',
          access_level TEXT NOT NULL DEFAULT 'everyone',
          in_rotation BOOLEAN NOT NULL DEFAULT FALSE
        )
      `);
      await client.query(`ALTER TABLE custom_commands ADD COLUMN IF NOT EXISTS in_rotation BOOLEAN NOT NULL DEFAULT FALSE`);
      await client.query(`ALTER TABLE custom_commands ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'everyone'`);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_custom_commands_enabled ON custom_commands(enabled)`);

      // Таблица счетчиков (для команд типа !смерть, !стоп)
      await client.query(`
        CREATE TABLE IF NOT EXISTS counters (
          id TEXT PRIMARY KEY,
          trigger TEXT NOT NULL UNIQUE,
          aliases TEXT[] NOT NULL DEFAULT '{}',
          response_template TEXT NOT NULL,
          value INTEGER NOT NULL DEFAULT 0,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          description TEXT NOT NULL DEFAULT '',
          access_level TEXT NOT NULL DEFAULT 'everyone'
        )
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_counters_enabled ON counters(enabled)`);
      await client.query(`ALTER TABLE counters ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'everyone'`);

      // Таблица элементов партии (список на выдачу)
      await client.query(`
        CREATE TABLE IF NOT EXISTS party_items (
          id SERIAL PRIMARY KEY,
          text TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0
        )
      `);

      // Настройки партии: триггер, начальный текст ответа, сколько названий выдавать, макс количество на каждое
      await client.query(`
        CREATE TABLE IF NOT EXISTS party_config (
          id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          elements_count INTEGER NOT NULL DEFAULT 2,
          quantity_max INTEGER NOT NULL DEFAULT 4,
          skip_cooldown BOOLEAN NOT NULL DEFAULT FALSE
        )
      `);
      await client.query(
        `ALTER TABLE party_config ADD COLUMN IF NOT EXISTS skip_cooldown BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query(
        `ALTER TABLE party_config ADD COLUMN IF NOT EXISTS trigger TEXT NOT NULL DEFAULT '!партия'`,
      );
      await client.query(
        `ALTER TABLE party_config ADD COLUMN IF NOT EXISTS response_text TEXT NOT NULL DEFAULT 'Партия выдала'`,
      );
      await client.query(
        `ALTER TABLE party_config ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true`,
      );
      await client.query(`
        INSERT INTO party_config (id, elements_count, quantity_max, skip_cooldown) VALUES (1, 2, 4, FALSE)
        ON CONFLICT (id) DO NOTHING
      `);

      // Настройки дуэлей: таймаут, очки, штраф за промах (одна строка)
      await client.query(`
        CREATE TABLE IF NOT EXISTS duel_config (
          id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          duels_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          timeout_minutes INTEGER NOT NULL DEFAULT 5,
          win_points INTEGER NOT NULL DEFAULT 25,
          loss_points INTEGER NOT NULL DEFAULT 25,
          miss_penalty INTEGER NOT NULL DEFAULT 5,
          overlay_sync_enabled BOOLEAN NOT NULL DEFAULT TRUE
        )
      `);
      await client.query(`
        ALTER TABLE duel_config ADD COLUMN IF NOT EXISTS duels_enabled BOOLEAN NOT NULL DEFAULT TRUE
      `).catch(() => {});
      await client.query(`
        ALTER TABLE duel_config ADD COLUMN IF NOT EXISTS miss_penalty INTEGER NOT NULL DEFAULT 5
      `).catch(() => {});
      await client.query(`
        ALTER TABLE duel_config ADD COLUMN IF NOT EXISTS overlay_sync_enabled BOOLEAN NOT NULL DEFAULT TRUE
      `).catch(() => {});
      await client.query(`
        INSERT INTO duel_config (id, duels_enabled, timeout_minutes, win_points, loss_points, miss_penalty, overlay_sync_enabled)
        VALUES (1, TRUE, 5, 25, 25, 5, TRUE)
        ON CONFLICT (id) DO NOTHING
      `);

      // Настройки модерации чата: вкл/выкл, проверка по символам, по буквам, лимиты, таймаут
      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_moderation_config (
          id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          moderation_enabled BOOLEAN NOT NULL DEFAULT true,
          check_symbols BOOLEAN NOT NULL DEFAULT true,
          check_letters BOOLEAN NOT NULL DEFAULT true,
          max_message_length INTEGER NOT NULL DEFAULT 300,
          max_letters_digits INTEGER NOT NULL DEFAULT 300,
          timeout_minutes INTEGER NOT NULL DEFAULT 10
        )
      `);
      await client.query(`
        ALTER TABLE chat_moderation_config ADD COLUMN IF NOT EXISTS max_letters_digits INTEGER NOT NULL DEFAULT 300
      `).catch(() => {});
      await client.query(`
        ALTER TABLE chat_moderation_config ADD COLUMN IF NOT EXISTS moderation_enabled BOOLEAN NOT NULL DEFAULT true
      `).catch(() => {});
      await client.query(`
        ALTER TABLE chat_moderation_config ADD COLUMN IF NOT EXISTS check_symbols BOOLEAN NOT NULL DEFAULT true
      `).catch(() => {});
      await client.query(`
        ALTER TABLE chat_moderation_config ADD COLUMN IF NOT EXISTS check_letters BOOLEAN NOT NULL DEFAULT true
      `).catch(() => {});
      await client.query(`
        ALTER TABLE chat_moderation_config ADD COLUMN IF NOT EXISTS check_links BOOLEAN NOT NULL DEFAULT false
      `).catch(() => {});
      await client.query(`
        INSERT INTO chat_moderation_config (id, max_message_length, max_letters_digits, timeout_minutes)
        VALUES (1, 300, 300, 10)
        ON CONFLICT (id) DO NOTHING
      `);

      // Whitelist разрешённых ссылок для модерации (бот пропускает эти ссылки)
      await client.query(`
        CREATE TABLE IF NOT EXISTS link_whitelist (
          id SERIAL PRIMARY KEY,
          pattern TEXT NOT NULL
        )
      `);

      // Дейлики дуэлей: ежедневная награда и серия побед (одна строка)
      await client.query(`
        CREATE TABLE IF NOT EXISTS duel_daily_config (
          id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          daily_games_count INTEGER NOT NULL DEFAULT 5,
          daily_reward_points INTEGER NOT NULL DEFAULT 50,
          streak_wins_count INTEGER NOT NULL DEFAULT 3,
          streak_reward_points INTEGER NOT NULL DEFAULT 100
        )
      `);
      await client.query(`
        INSERT INTO duel_daily_config (id, daily_games_count, daily_reward_points, streak_wins_count, streak_reward_points)
        VALUES (1, 5, 50, 3, 100)
        ON CONFLICT (id) DO NOTHING
      `);

      // Конфиг текста для команды !ссылки + интервал ротации (одна строка)
      await client.query(`
        CREATE TABLE IF NOT EXISTS links_config (
          id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          all_links_text TEXT NOT NULL DEFAULT '',
          rotation_interval_minutes INTEGER NOT NULL DEFAULT 13
        )
      `);
      await client.query(`ALTER TABLE links_config ADD COLUMN IF NOT EXISTS rotation_interval_minutes INTEGER NOT NULL DEFAULT 13`);
      await client.query(`
        INSERT INTO links_config (id, all_links_text, rotation_interval_minutes) VALUES (1, '', 13)
        ON CONFLICT (id) DO NOTHING
      `);

      // Кулдаун партии: пользователь — раз в сутки
      await client.query(`
        CREATE TABLE IF NOT EXISTS party_cooldown (
          twitch_username TEXT PRIMARY KEY,
          last_used_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Админы админ-панели (логин + bcrypt-хеш пароля)
      await client.query(`
        CREATE TABLE IF NOT EXISTS admin_users (
          id SERIAL PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(LOWER(username))`);

      // Журнал событий (сообщения чата, команды, системные события) — по аналогии с Nightbot
      await client.query(`
        CREATE TABLE IF NOT EXISTS event_journal (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          username TEXT NOT NULL DEFAULT '',
          message TEXT NOT NULL,
          event_type TEXT NOT NULL DEFAULT 'message'
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_event_journal_created_at ON event_journal(created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_event_journal_username ON event_journal(LOWER(username))`);

      // Журнал действий админов (из админ-панели)
      await client.query(`
        CREATE TABLE IF NOT EXISTS admin_action_journal (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          admin_username TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT ''
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_action_journal_created_at ON admin_action_journal(created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_action_journal_username ON admin_action_journal(LOWER(admin_username))`);

      // Конфиг сообщения при входящем рейде
      await client.query(`
        CREATE TABLE IF NOT EXISTS raid_config (
          id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          raid_message TEXT NOT NULL DEFAULT ''
        )
      `);
      await client.query(`
        INSERT INTO raid_config (id, raid_message) VALUES (1, '')
        ON CONFLICT (id) DO NOTHING
      `);

      // Добавляем дефолтные элементы партии если таблица пустая (только названия, количество 1–4 генерируется при выдаче)
      const partyCount = await client.query('SELECT COUNT(*)::int AS cnt FROM party_items');
      if (partyCount.rows[0]?.cnt === 0) {
        const defaultItems = [
          'дракоша‑сосед', 'хомяко‑адвоката', 'кактусо‑бабушка', 'рыбо‑начальника', 'пауко‑стилист',
          'сороконожко‑танцора', 'медузо‑бухгалтер', 'жуко‑почтальона', 'слоно‑бариста', 'крокодило‑стилиста',
          'пингвино‑диджея', 'ёжико‑библиотекаря', 'осьминожко‑массажиста', 'лягушко‑поэта', 'динозавро‑курьера',
          'Лида‑тимлид', 'таракан‑финансовый аналитик', 'червяко‑менеджера по продажам', 'плесень‑HR‑специалист',
          'слизняко‑директор', 'личинка‑стажёр', 'клопо‑рекрутера', 'пыль‑аналитика', 'блохо‑маркетолога',
          'HRюшу', 'кот‑аудитор', 'хомяка‑криптоинвестора', 'попугай‑юрист', 'бабочки‑дизайнера',
          'лягушки‑коуча', 'краб‑ревизор', 'бобр‑строитель', 'осьминог‑многостаночник', 'нэко‑тян бухгалтер',
          'моти‑котика', 'кицунэ', 'юки‑нэко', 'пика‑ня', 'бублик‑куна', 'почита‑няшки', 'данго‑няшки',
        ];
        for (let i = 0; i < defaultItems.length; i++) {
          await client.query('INSERT INTO party_items (text, sort_order) VALUES ($1, $2)', [defaultItems[i], i]);
        }
        console.log(`📝 Создано ${defaultItems.length} элементов партии по умолчанию`);
      }

      // Добавляем дефолтные счётчики если таблица пустая
      const countersCount = await client.query('SELECT COUNT(*)::int AS cnt FROM counters');
      if (countersCount.rows[0]?.cnt === 0) {
        console.log('📝 Создаём дефолтные счётчики...');
        
        await client.query(`
          INSERT INTO counters (id, trigger, aliases, response_template, value, enabled, description)
          VALUES 
            ('death', '!смерть', ARRAY['!death', '!дед'], 'Смертей: {value}', 0, true, 'Счётчик смертей в игре'),
            ('stop', '!стоп', ARRAY['!stop', '!pause', '!пауза'], 'Количество стопов: {value}', 0, true, 'Счётчик остановок/пауз')
          ON CONFLICT (id) DO NOTHING
        `);
        
        console.log('✅ Дефолтные счётчики созданы');
      }

      console.log('[DATABASE] Таблицы Twitch бота созданы/обновлены');
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('⚠️ [DATABASE] Ошибка подключения, продолжаем без БД:', error);
  }
}
