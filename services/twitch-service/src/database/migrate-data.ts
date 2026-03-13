import { initDatabase, getPool, closeDatabase } from './database';
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
  duelsToday?: number;
  lastDuelDate?: string;
  lastDailyQuestRewardDate?: string;
  duelWinStreak?: number;
  streakRewardActive?: boolean;
}

interface StreamHistoryEntry {
  date: string;
  startTime: string;
  duration: string;
  peakViewers: number;
  followsCount?: number;
}

interface CustomCommandJson {
  id: string;
  trigger: string;
  aliases: string[];
  response: string;
  enabled: boolean;
  cooldown: number;
  messageType: 'announcement' | 'message';
  color: 'primary' | 'blue' | 'green' | 'orange' | 'purple';
  description: string;
}

const SERVICE_ROOT = (() => {
  let root = process.cwd();
  if (fs.existsSync(path.join(root, 'package.json'))) return root;
  root = path.resolve(process.cwd(), '../..');
  if (fs.existsSync(path.join(root, 'package.json'))) return root;
  return process.cwd();
})();

const MONOREPO_ROOT = path.resolve(SERVICE_ROOT, '..', '..');
const TWITCH_PLAYERS_JSON = path.join(MONOREPO_ROOT, 'twitch-players.json');
const STREAM_HISTORY_JSON = path.join(MONOREPO_ROOT, 'stream-history.json');
const CUSTOM_COMMANDS_JSON = path.join(SERVICE_ROOT, 'src', 'data', 'custom-commands.json');
const COUNTERS_STATE_JSON = path.join(MONOREPO_ROOT, 'counters-state.json');
const FORCE_MODE = process.argv.includes('--force');

async function migrateTwitchPlayers(): Promise<number> {
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

  const pool = getPool();
  const client = await pool.connect();
  let migratedCount = 0;

  try {
    if (FORCE_MODE) {
      await client.query('DELETE FROM twitch_player_stats');
    }

    for (const player of playersArray) {
      const norm = player.twitchUsername.toLowerCase();

      if (!FORCE_MODE) {
        const existing = await client.query(
          'SELECT twitch_username FROM twitch_player_stats WHERE twitch_username = $1',
          [norm]
        );
        if (existing.rows.length > 0) {
          console.log(`⏭️  Пропускаем ${player.twitchUsername} (уже существует)`);
          continue;
        }
      }

      await client.query(
        `INSERT INTO twitch_player_stats (twitch_username, size, last_used, last_used_date, points,
          duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws,
          duels_today, last_duel_date, last_daily_quest_reward_date,
          duel_win_streak, streak_reward_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15)`,
        [
          norm,
          player.size,
          player.lastUsed,
          player.lastUsedDate || null,
          player.points || 1000,
          player.duelTimeoutUntil || null,
          player.duelCooldownUntil || null,
          player.duelWins || 0,
          player.duelLosses || 0,
          player.duelDraws || 0,
          player.duelsToday ?? 0,
          player.lastDuelDate || null,
          player.lastDailyQuestRewardDate || null,
          player.duelWinStreak ?? 0,
          player.streakRewardActive ?? false
        ]
      );

      migratedCount++;
      console.log(`✅ Мигрирован: ${player.twitchUsername}`);
    }
  } finally {
    client.release();
  }

  const backupPath = TWITCH_PLAYERS_JSON + '.backup';
  fs.copyFileSync(TWITCH_PLAYERS_JSON, backupPath);
  console.log(`💾 Создана резервная копия: ${backupPath}`);
  return migratedCount;
}

async function migrateStreamHistory(): Promise<number> {
  if (!fs.existsSync(STREAM_HISTORY_JSON)) {
    console.log('⚠️  stream-history.json не найден, пропускаем');
    return 0;
  }

  const jsonData = fs.readFileSync(STREAM_HISTORY_JSON, 'utf-8');
  const historyArray: StreamHistoryEntry[] = JSON.parse(jsonData);
  console.log(`\n📊 Найдено записей истории стримов: ${historyArray.length}`);

  const pool = getPool();
  const client = await pool.connect();
  let migratedCount = 0;

  try {
    if (FORCE_MODE) {
      await client.query('DELETE FROM stream_history');
    }

    for (const entry of historyArray) {
      if (!FORCE_MODE) {
        const existing = await client.query(
          'SELECT id FROM stream_history WHERE stream_date = $1 AND start_time = $2',
          [entry.date, entry.startTime]
        );
        if (existing.rows.length > 0) {
          console.log(`⏭️  Пропускаем стрим ${entry.date} ${entry.startTime} (уже существует)`);
          continue;
        }
      }

      await client.query(
        `INSERT INTO stream_history (stream_date, start_time, duration, peak_viewers, follows_count)
        VALUES ($1, $2, $3, $4, $5)`,
        [entry.date, entry.startTime, entry.duration, entry.peakViewers, entry.followsCount || null]
      );

      migratedCount++;
      console.log(`✅ Мигрирован стрим: ${entry.date} ${entry.startTime}`);
    }
  } finally {
    client.release();
  }

  const backupPath = STREAM_HISTORY_JSON + '.backup';
  fs.copyFileSync(STREAM_HISTORY_JSON, backupPath);
  console.log(`💾 Создана резервная копия: ${backupPath}`);
  return migratedCount;
}

async function migrateCustomCommands(): Promise<number> {
  if (!fs.existsSync(CUSTOM_COMMANDS_JSON)) {
    console.log('⚠️  custom-commands.json не найден, пропускаем миграцию команд');
    return 0;
  }

  const jsonRaw = fs.readFileSync(CUSTOM_COMMANDS_JSON, 'utf-8');
  const parsed = JSON.parse(jsonRaw) as { commands: CustomCommandJson[] };
  const commands = parsed.commands ?? [];
  console.log(`\n📊 Найдено кастомных команд: ${commands.length}`);

  const pool = getPool();
  const client = await pool.connect();
  let migratedCount = 0;

  try {
    const res = await client.query('SELECT COUNT(*)::int AS cnt FROM custom_commands');
    const existingCount = res.rows[0]?.cnt ?? 0;

    if (existingCount > 0 && !FORCE_MODE) {
      console.log(`⏭️  В таблице custom_commands уже есть ${existingCount} записей, пропускаем импорт`);
      return 0;
    }

    if (FORCE_MODE) {
      console.log('🔄 Режим --force: очищаем custom_commands и импортируем заново');
      await client.query('DELETE FROM custom_commands');
    }

    for (const cmd of commands) {
      await client.query(
        `INSERT INTO custom_commands
          (id, trigger, aliases, response, enabled, cooldown, message_type, color, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           trigger = EXCLUDED.trigger,
           aliases = EXCLUDED.aliases,
           response = EXCLUDED.response,
           enabled = EXCLUDED.enabled,
           cooldown = EXCLUDED.cooldown,
           message_type = EXCLUDED.message_type,
           color = EXCLUDED.color,
           description = EXCLUDED.description`,
        [
          cmd.id,
          cmd.trigger,
          cmd.aliases ?? [],
          cmd.response,
          cmd.enabled ?? true,
          cmd.cooldown ?? 10,
          cmd.messageType ?? 'announcement',
          cmd.color ?? 'primary',
          cmd.description ?? '',
        ],
      );
      migratedCount++;
      console.log(`✅ Импортирована команда: ${cmd.id} (${cmd.trigger})`);
    }

    return migratedCount;
  } finally {
    client.release();
  }
}

async function migrateCountersState(): Promise<number> {
  if (!fs.existsSync(COUNTERS_STATE_JSON)) {
    console.log('⚠️  counters-state.json не найден, пропускаем миграцию значений счётчиков');
    return 0;
  }

  const jsonRaw = fs.readFileSync(COUNTERS_STATE_JSON, 'utf-8');
  const state = JSON.parse(jsonRaw) as { stopCounters?: Record<string, number>, deathCounters?: Record<string, number> };
  
  console.log(`\n📊 Найдены счётчики в файле состояния`);

  const pool = getPool();
  const client = await pool.connect();
  let updatedCount = 0;

  try {
    // Обновляем значение для !стоп
    if (state.stopCounters) {
      const stopValues = Object.values(state.stopCounters);
      if (stopValues.length > 0) {
        const totalStops = stopValues.reduce((sum, val) => sum + val, 0);
        await client.query(
          `UPDATE counters SET value = $1 WHERE id = 'stop'`,
          [totalStops]
        );
        console.log(`✅ Счётчик !стоп обновлён: ${totalStops}`);
        updatedCount++;
      }
    }

    // Обновляем значение для !смерть
    if (state.deathCounters) {
      const deathValues = Object.values(state.deathCounters);
      if (deathValues.length > 0) {
        const totalDeaths = deathValues.reduce((sum, val) => sum + val, 0);
        await client.query(
          `UPDATE counters SET value = $1 WHERE id = 'death'`,
          [totalDeaths]
        );
        console.log(`✅ Счётчик !смерть обновлён: ${totalDeaths}`);
        updatedCount++;
      }
    }

    return updatedCount;
  } finally {
    client.release();
  }
}

async function migrateData() {
  console.log('🚀 Запуск миграции данных Twitch бота из JSON в PostgreSQL...');
  if (FORCE_MODE) {
    console.log('⚡ Режим --force: полная перезапись данных');
  }

  try {
    await initDatabase();

    const playersCount = await migrateTwitchPlayers();
    const historyCount = await migrateStreamHistory();
    const commandsCount = await migrateCustomCommands();
    const countersCount = await migrateCountersState();

    console.log('\n📈 Результаты миграции:');
    console.log(`   ✅ Twitch игроков: ${playersCount}`);
    console.log(`   ✅ Записей истории: ${historyCount}`);
    console.log(`   ✅ Кастомных команд: ${commandsCount}`);
    console.log(`   ✅ Счётчиков: ${countersCount}`);
    console.log(`   📊 Всего: ${playersCount + historyCount + commandsCount + countersCount}`);

    console.log('\nℹ️  Старые JSON файлы можно удалить после проверки работы БД');

    await closeDatabase();
    console.log('\n✅ Миграция успешно завершена!');
  } catch (error) {
    console.error('❌ Ошибка при миграции:', error);
    await closeDatabase();
    process.exit(1);
  }
}

migrateData();
