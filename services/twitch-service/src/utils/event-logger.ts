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

// Создаём папку logs если её нет
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

type EventType = 
  | 'STREAM_ONLINE' 
  | 'STREAM_OFFLINE' 
  | 'COMMAND' 
  | 'DUEL_RESULT'
  | 'ERROR'
  | 'BOT_START'
  | 'BOT_STOP'
  | 'CONNECTION';

interface EventLogData {
  timestamp: string;
  type: EventType;
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
 * Записывает событие в лог-файл
 */
function writeEventLog(type: EventType, data: any): void {
  try {
    const logEntry: EventLogData = {
      timestamp: formatTimestamp(),
      type,
      data
    };
    
    const logLine = JSON.stringify(logEntry) + '\n';
    fs.appendFileSync(EVENT_LOG_FILE, logLine, 'utf-8');
  } catch (error) {
    console.error('❌ Ошибка записи в event log:', error);
  }
}

/**
 * Универсальная функция для логирования событий
 */
export function log(type: EventType, data: any): void {
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
    
    return recentLines.map(line => JSON.parse(line));
  } catch (error) {
    console.error('❌ Ошибка чтения event log:', error);
    return [];
  }
}

/**
 * Очищает старые логи (опционально, для предотвращения разрастания файла)
 */
export function rotateLogs(keepLastDays: number = 30): void {
  try {
    if (!fs.existsSync(EVENT_LOG_FILE)) {
      return;
    }
    
    const content = fs.readFileSync(EVENT_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    
    const cutoffDate = Date.now() - (keepLastDays * 24 * 60 * 60 * 1000);
    
    const recentLines = lines.filter(line => {
      try {
        const entry = JSON.parse(line) as EventLogData;
        const entryDate = new Date(entry.timestamp).getTime();
        return entryDate > cutoffDate;
      } catch {
        return true; // Оставляем строки с ошибками парсинга
      }
    });
    
    if (recentLines.length < lines.length) {
      fs.writeFileSync(EVENT_LOG_FILE, recentLines.join('\n') + '\n', 'utf-8');
      console.log(`🗑️ Удалено ${lines.length - recentLines.length} старых записей из лога`);
    }
  } catch (error) {
    console.error('❌ Ошибка ротации логов:', error);
  }
}
