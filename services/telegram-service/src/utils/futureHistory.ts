import * as fs from 'fs';
import * as path from 'path';

const HISTORY_FILE = path.join(process.cwd(), 'future_history.json');

interface FutureHistory {
  predictions: string[];
}

export function loadFutureHistory(): string[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      const history: FutureHistory = JSON.parse(data);
      return history.predictions || [];
    }
  } catch (error) {
    console.error('Ошибка при чтении future:', error);
  }
  return [];
}

export function saveFutureHistory(predictions: string[]): void {
  try {
    const history: FutureHistory = { predictions };
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
  } catch (error) {
    console.error('Ошибка при сохранении future:', error);
  }
}

export function clearHistory(): void {
  saveFutureHistory([]);
}

export function addToHistory(prediction: string): void {
  const history = loadFutureHistory();
  
  const filtered = history.filter(p => p !== prediction);
  
  filtered.unshift(prediction);
  
  saveFutureHistory(filtered);
}

export function getAvailablePredictions(allPredictions: string[]): string[] {
  const history = loadFutureHistory();
  const historySet = new Set(history);
  
  return allPredictions.filter(prediction => !historySet.has(prediction));
}
