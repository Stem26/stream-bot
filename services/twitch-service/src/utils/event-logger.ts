import * as fs from 'fs';
import * as path from 'path';

// Логи хранятся в корне монорепозитория
const MONOREPO_ROOT = (() => {
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

const LOGS_DIR = path.join(MONOREPO_ROOT, 'logs');
const EVENT_LOG_FILE = path.join(LOGS_DIR, 'events.log');

/** После фильтра по дате — если файл всё ещё огромный (шум за 30 дней), обрезаем хвост по строкам. */
const MAX_EVENT_LOG_BYTES = 25 * 1024 * 1024;
const MAX_EVENT_LOG_TAIL_LINES = 80_000;

// Создаём папку logs если её нет
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

type EventType =
  | 'STREAM_ONLINE'
  | 'STREAM_ONLINE_DEDUP'
  | 'STREAM_ONLINE_RECOVERED'
  | 'STREAM_OFFLINE'
  | 'STREAM_STATUS_PROBE'
  | 'TELEGRAM_STREAM_ONLINE_SENT'
  | 'TELEGRAM_STREAM_ONLINE_FAILED'
  | 'TELEGRAM_STREAM_OFFLINE_SENT'
  | 'TELEGRAM_STREAM_OFFLINE_FAILED'
  | 'TELEGRAM_STREAM_ONLINE_FORCED_ON_STARTUP'
  | 'TELEGRAM_STREAM_ONLINE_SKIPPED_NO_CHANNEL_ID'
  | 'TELEGRAM_STREAM_ONLINE_SKIPPED_DUPLICATE'
  | 'TELEGRAM_STREAM_ONLINE_SKIPPED_INITIAL_STARTUP'
  | 'COMMAND'
  | 'DUEL_RESULT'
  | 'WARN'
  | 'ERROR'
  | 'BOT_START'
  | 'BOT_STOP'
  | 'CONNECTION'
  | 'EVENTSUB_WEBSOCKET'
  | 'EVENTSUB_KEEPALIVE'
  | 'EVENTSUB_NOTIFICATION'
  | 'EVENTSUB_RECONNECT'
  | 'EVENTSUB_RECONNECT_REQUEST'
  | 'EVENTSUB_RECONNECT_DEGRADED'
  | 'EVENTSUB_SUBSCRIBE_SESSION_MISMATCH'
  | 'TELEGRAM_RATE_LIMIT'
  | 'EVENTSUB_RAW'
  | 'STREAMS_API_SKIP'
  | 'ANNOUNCEMENTS_API_SKIP';

type EventTypeExtended = EventType;

interface EventLogData {
  timestamp: string;
  type: EventTypeExtended;
  data: any;
}

/**
 * Форматирует дату и время в читаемый формат
 */
function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace('T', ' ').split('.')[0];
}

/**
 * Записывает событие в лог-файл (асинхронный append — не блокирует event loop).
 */
function writeEventLog(type: EventTypeExtended, data: any): void {
  try {
    const logEntry: EventLogData = {
      timestamp: formatTimestamp(),
      type,
      data
    };

    const logLine = JSON.stringify(logEntry) + '\n';
    fs.appendFile(EVENT_LOG_FILE, logLine, 'utf-8', err => {
      if (err) {
        console.error('❌ Ошибка записи в event log:', err);
      }
    });
  } catch (error) {
    console.error('❌ Ошибка записи в event log:', error);
  }
}

/**
 * Универсальная функция для логирования событий
 */
export function log(type: EventTypeExtended, data: any): void {
  writeEventLog(type, data);

  // Дополнительный вывод в консоль для некоторых типов событий
  switch (type) {
    case 'ERROR':
      console.error(`❌ [ERROR] ${data.context}: ${data.error}`);
      break;
    case 'BOT_START':
      console.log('🚀 [LOG] Бот запущен');
      break;
    case 'BOT_STOP':
      console.log('🛑 [LOG] Бот остановлен');
      break;
    case 'CONNECTION':
      const emoji = data.status === 'connected' ? '✅' : data.status === 'disconnected' ? '⚠️' : data.status === 'error' ? '❌' : '🔄';
      console.log(`${emoji} [LOG] ${data.service}: ${data.status}`);
      break;
  }
}

/**
 * Читает последние N записей из лога
 */
export function readRecentLogs(limit: number = 50): EventLogData[] {
  try {
    if (!fs.existsSync(EVENT_LOG_FILE)) {
      return [];
    }

    const content = fs.readFileSync(EVENT_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    const recentLines = lines.slice(-limit);

    return recentLines.flatMap(line => {
      try {
        return [JSON.parse(line) as EventLogData];
      } catch {
        return [];
      }
    });
  } catch (error) {
    console.error('❌ Ошибка чтения event log:', error);
    return [];
  }
}

async function rotateLogsAsync(keepLastDays: number = 30): Promise<void> {
  const { readFile, writeFile } = fs.promises;
  let content: string;
  try {
    content = await readFile(EVENT_LOG_FILE, 'utf-8');
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return;
    }
    throw e;
  }
  try {
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    if (lines.length === 0) {
      return;
    }

    const cutoffDate = Date.now() - keepLastDays * 24 * 60 * 60 * 1000;

    let kept = lines.filter(line => {
      try {
        const entry = JSON.parse(line) as EventLogData;
        const entryDate = new Date(entry.timestamp).getTime();
        return entryDate > cutoffDate;
      } catch {
        return true;
      }
    });

    let sizeTrimmed = false;
    let body = kept.join('\n') + '\n';
    if (Buffer.byteLength(body, 'utf8') > MAX_EVENT_LOG_BYTES) {
      kept = kept.slice(-MAX_EVENT_LOG_TAIL_LINES);
      body = kept.join('\n') + '\n';
      sizeTrimmed = true;
      console.warn(
        `⚠️ events.log сокращён по объёму (~>${MAX_EVENT_LOG_BYTES / (1024 * 1024)} MiB), оставлены последние ${kept.length} строк`
      );
    }

    const changed = kept.length < lines.length || sizeTrimmed;
    if (changed) {
      await writeFile(EVENT_LOG_FILE, body, 'utf-8');
      const removed = lines.length - kept.length;
      if (removed > 0) {
        console.log(`🗑️ Ротация events.log: удалено ${removed} строк (порог по дате и/или размеру)`);
      }
    }
  } catch (error) {
    console.error('❌ Ошибка ротации логов:', error);
  }
}

/** Последовательная очередь — не теряем вызовы и не пишем файл параллельно. */
let rotateLogsChain: Promise<void> = Promise.resolve();

/**
 * Ротация по дате + ограничение размера. Не блокирует event loop (fs.promises).
 */
export function rotateLogs(keepLastDays: number = 30): void {
  rotateLogsChain = rotateLogsChain
    .then(() => rotateLogsAsync(keepLastDays))
    .catch(err => {
      console.error('❌ Ошибка ротации логов:', err);
    });
}

/** Одна попытка ротации при старте + раз в сутки (импорт event-logger подключает расписание). */
let eventLogRotationScheduled = false;
function ensureEventLogRotationScheduled(): void {
  if (eventLogRotationScheduled) {
    return;
  }
  eventLogRotationScheduled = true;
  const dayMs = 24 * 60 * 60 * 1000;
  setImmediate(() => {
    try {
      rotateLogs();
    } catch (e) {
      console.error('❌ rotateLogs при старте:', e);
    }
  });
  setInterval(() => {
    try {
      rotateLogs();
    } catch (e) {
      console.error('❌ rotateLogs по расписанию:', e);
    }
  }, dayMs);
}

ensureEventLogRotationScheduled();
