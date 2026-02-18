import * as fs from 'fs';
import * as path from 'path';

export interface StreamHistoryEntry {
  date: string;
  startTime: string;
  duration: string;
  peakViewers: number;
  game?: string;
  title?: string;
}

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

const STREAM_HISTORY_FILE = path.join(MONOREPO_ROOT, 'stream-history.json');

console.log(`[STREAM-HISTORY] Путь к файлу: ${STREAM_HISTORY_FILE}`);

/**
 * Загружает историю стримов из файла
 */
export function loadStreamHistory(): StreamHistoryEntry[] {
  try {
    if (fs.existsSync(STREAM_HISTORY_FILE)) {
      const data = fs.readFileSync(STREAM_HISTORY_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('⚠️ Ошибка загрузки истории стримов:', error);
  }
  return [];
}

/**
 * Сохраняет историю стримов в файл
 */
export function saveStreamHistory(history: StreamHistoryEntry[]): void {
  try {
    fs.writeFileSync(STREAM_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    console.log('✅ История стримов сохранена');
  } catch (error) {
    console.error('⚠️ Ошибка сохранения истории стримов:', error);
  }
}

/**
 * Добавляет запись о стриме в историю
 */
export function addStreamToHistory(entry: StreamHistoryEntry): void {
  const history = loadStreamHistory();
  history.push(entry);
  
  saveStreamHistory(history);
}
