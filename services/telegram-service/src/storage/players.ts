import * as fs from 'fs';
import * as path from 'path';

export interface PlayerData {
  userId: number;
  username: string;
  firstName: string;
  size: number;
  lastUsed: number;
  lastUsedDate?: string;
  lastHornyDate?: string;
  lastFurryDate?: string;
  lastFutureDate?: string;
  futureAttemptsToday?: number;
}

// Файл для хранения данных игроков
// Сохраняем в корне монорепозитория независимо от cwd
const MONOREPO_ROOT = (() => {
  // Сначала пробуем найти package.json в текущей директории
  let root = process.cwd();
  if (fs.existsSync(path.join(root, 'package.json'))) {
    return root;
  }
  // Если не нашли, поднимаемся вверх (для случая когда cwd = services/telegram-service)
  root = path.resolve(process.cwd(), '../..');
  if (fs.existsSync(path.join(root, 'package.json'))) {
    return root;
  }
  // Если всё ещё не нашли, используем текущую директорию
  return process.cwd();
})();

const PLAYERS_FILE = path.join(MONOREPO_ROOT, 'players.json');

console.log(`[PLAYERS] Путь к файлу: ${PLAYERS_FILE}`);

// Функция для загрузки данных игроков
export function loadPlayers(): Map<number, PlayerData> {
  const players = new Map<number, PlayerData>();

  try {
    if (fs.existsSync(PLAYERS_FILE)) {
      const data = fs.readFileSync(PLAYERS_FILE, 'utf-8');
      const playersArray: PlayerData[] = JSON.parse(data);
      playersArray.forEach(player => {
        players.set(player.userId, player);
      });
    }
  } catch (error) {
    console.error('Ошибка при чтении players.json:', error);
  }

  return players;
}

// Функция для сохранения данных игроков
export function savePlayers(players: Map<number, PlayerData>): void {
  try {
    const playersArray = Array.from(players.values());
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(playersArray, null, 2), 'utf-8');
  } catch (error) {
    console.error('Ошибка при сохранении players.json:', error);
  }
}

// Функция для получения места игрока в топе
export function getPlayerRank(players: Map<number, PlayerData>, userId: number): number {
  const sortedPlayers = Array.from(players.values())
    .sort((a, b) => b.size - a.size);

  const rank = sortedPlayers.findIndex(p => p.userId === userId);

  return rank >= 0 ? rank + 1 : players.size + 1;
}

