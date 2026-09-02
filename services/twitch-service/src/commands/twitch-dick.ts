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

function formatPlayMessage(twitchUsername: string, growth: number, size: number): string {
  if (growth === 0) {
    return `@${twitchUsername}, твой писюн не изменился и теперь равен ${size} см.`;
  }
  const growthText = growth > 0
    ? `вырос на ${growth}`
    : `уменьшился на ${Math.abs(growth)}`;
  return `@${twitchUsername}, твой писюн ${growthText} см и теперь равен ${size} см.`;
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

export async function processTwitchDickCommand(
  twitchUsername: string,
  twitchUserId?: string,
): Promise<string> {
  const normalizedUsername = twitchUsername.toLowerCase();
  const resolved = await storage.resolvePlayerData(twitchUsername, twitchUserId);
  const players = await storage.loadTwitchPlayers();
  if (resolved) {
    if (resolved.twitchUserId) {
      for (const [key, p] of players.entries()) {
        if (p.twitchUserId === resolved.twitchUserId && key !== normalizedUsername) {
          players.delete(key);
        }
      }
    }
    players.set(normalizedUsername, resolved);
  }
  let player = players.get(normalizedUsername);
  const today = getMoscowDate();
  const now = Date.now();
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

    return formatPlayMessage(twitchUsername, growth, player.size);
  } else if (canPlay && player) {
    const growth = await generateGrowth(normalizedUsername, players);
    player.size += growth;
    player.lastUsed = now;
    player.lastUsedDate = today;
    player.twitchUsername = twitchUsername;
    players.set(normalizedUsername, player);
    await storage.saveTwitchPlayers(players);

    return formatPlayMessage(twitchUsername, growth, player.size);
  } else if (player) {
    const rank = await storage.getTwitchPlayerRank(players, normalizedUsername);
    return `@${twitchUsername}, ты уже играл. Сейчас он равен ${player.size} см. Ты занимаешь ${rank} место в топе. Следующая попытка завтра!`;
  }

  return `@${twitchUsername}, произошла ошибка при обработке команды.`;
}
