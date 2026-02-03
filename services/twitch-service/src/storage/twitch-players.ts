import * as fs from 'fs';
import * as path from 'path';

export interface TwitchPlayerData {
  twitchUsername: string;
  size: number;
  lastUsed: number;
  lastUsedDate?: string;
  points?: number;
  duelTimeoutUntil?: number;
  lastDuelUsed?: number;
}

const TWITCH_PLAYERS_FILE = path.join(process.cwd(), 'twitch-players.json');

// Функция для загрузки данных Twitch игроков
export function loadTwitchPlayers(): Map<string, TwitchPlayerData> {
  const players = new Map<string, TwitchPlayerData>();

  try {
    if (fs.existsSync(TWITCH_PLAYERS_FILE)) {
      const data = fs.readFileSync(TWITCH_PLAYERS_FILE, 'utf-8');
      const playersArray: TwitchPlayerData[] = JSON.parse(data);
      playersArray.forEach(player => {
        players.set(player.twitchUsername.toLowerCase(), player);
      });
    }
  } catch (error) {
    console.error('Ошибка при чтении twitch-players.json:', error);
  }

  return players;
}

// Функция для сохранения данных Twitch игроков
export function saveTwitchPlayers(players: Map<string, TwitchPlayerData>): void {
  try {
    const playersArray = Array.from(players.values());
    fs.writeFileSync(TWITCH_PLAYERS_FILE, JSON.stringify(playersArray, null, 2), 'utf-8');
  } catch (error) {
    console.error('Ошибка при сохранении twitch-players.json:', error);
  }
}

// Функция для получения места игрока в топе
export function getTwitchPlayerRank(players: Map<string, TwitchPlayerData>, username: string): number {
  const sortedPlayers = Array.from(players.values())
    .sort((a, b) => b.size - a.size);

  const rank = sortedPlayers.findIndex(p => p.twitchUsername.toLowerCase() === username.toLowerCase());

  return rank >= 0 ? rank + 1 : players.size + 1;
}
