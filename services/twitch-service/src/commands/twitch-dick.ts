import { TwitchPlayersStorageDB } from '../services/TwitchPlayersStorageDB';
import { getMoscowDate } from '../utils/date';
import { STREAMER_USERNAME } from '../config/env';

const storage = new TwitchPlayersStorageDB();

export interface TwitchPlayerData {
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
}

function canPlayTodayTwitch(player: TwitchPlayerData): boolean {
  const today = getMoscowDate();
  return !player.lastUsedDate || player.lastUsedDate !== today;
}

async function generateGrowth(normalizedUsername: string, players: Map<string, TwitchPlayerData>): Promise<number> {
  const isStreamer = STREAMER_USERNAME && normalizedUsername === STREAMER_USERNAME;

  if (isStreamer) {
    const rank = await storage.getTwitchPlayerRank(players, normalizedUsername);
    if (rank > 1) {
      const growth = Math.floor(Math.random() * 10) + 1;
      console.log(`🛡️ Защита стримера: выдан плюс ${growth} (ранг ${rank})`);
      return growth;
    }
  }

  return Math.floor(Math.random() * 21) - 10;
}

export async function processTwitchDickCommand(twitchUsername: string): Promise<string> {
  const players = await storage.loadTwitchPlayers();
  const today = getMoscowDate();
  const now = Date.now();
  const normalizedUsername = twitchUsername.toLowerCase();
  let player = players.get(normalizedUsername);
  const isFirstTime = !player;
  const canPlay = !player || canPlayTodayTwitch(player);

  if (isFirstTime) {
    const growth = await generateGrowth(normalizedUsername, players);
    player = {
      twitchUsername: twitchUsername,
      size: growth,
      lastUsed: now,
      lastUsedDate: today
    };
    players.set(normalizedUsername, player);
    await storage.saveTwitchPlayers(players);

    const growthText = growth > 0
      ? `вырос на ${growth}`
      : growth < 0
        ? `уменьшился на ${Math.abs(growth)}`
        : `не изменился`;

    return `@${twitchUsername}, твой писюн ${growthText} см. Теперь он равен ${player.size} см. Следующая попытка завтра!`;
  } else if (canPlay && player) {
    const growth = await generateGrowth(normalizedUsername, players);
    player.size += growth;
    player.lastUsed = now;
    player.lastUsedDate = today;
    player.twitchUsername = twitchUsername;
    players.set(normalizedUsername, player);
    await storage.saveTwitchPlayers(players);

    const growthText = growth > 0
      ? `вырос на ${growth}`
      : growth < 0
        ? `уменьшился на ${Math.abs(growth)}`
        : `не изменился`;

    return `@${twitchUsername}, твой писюн ${growthText} см. Теперь он равен ${player.size} см. Следующая попытка завтра!`;
  } else if (player) {
    const rank = await storage.getTwitchPlayerRank(players, normalizedUsername);
    return `@${twitchUsername}, ты уже играл. Сейчас он равен ${player.size} см. Ты занимаешь ${rank} место в топе. Следующая попытка завтра!`;
  }

  return `@${twitchUsername}, произошла ошибка при обработке команды.`;
}
