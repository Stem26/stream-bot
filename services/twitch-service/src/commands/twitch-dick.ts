import { loadTwitchPlayers, saveTwitchPlayers, getTwitchPlayerRank, TwitchPlayerData } from '../storage/twitch-players';
import { getMoscowDate, canPlayToday } from '../utils/date';
import { STREAMER_USERNAME } from '../config/env';

function canPlayTodayTwitch(player: TwitchPlayerData): boolean {
  const today = getMoscowDate();
  return !player.lastUsedDate || player.lastUsedDate !== today;
}

/**
 * Генерирует значение роста с учетом защиты для стримера
 * @param normalizedUsername - нормализованное имя пользователя
 * @param players - карта всех игроков для проверки ранга
 * @returns значение роста
 */
function generateGrowth(normalizedUsername: string, players: Map<string, TwitchPlayerData>): number {
  const isStreamer = STREAMER_USERNAME && normalizedUsername === STREAMER_USERNAME;
  
  // Защита для стримера: пока не на 1 месте - только плюсы 1..10
  if (isStreamer) {
    const rank = getTwitchPlayerRank(players, normalizedUsername);
    
    if (rank > 1) {
      const growth = Math.floor(Math.random() * 10) + 1; // 1..10
      console.log(`🛡️ Защита стримера: выдан плюс ${growth} (ранг ${rank})`);
      return growth;
    }
  }
  
  // Обычная механика для всех остальных (и для стримера на 1 месте)
  return Math.floor(Math.random() * 21) - 10;
}

/**
 * Обработка команды !dick из Twitch чата
 * @param twitchUsername - имя пользователя на Twitch
 * @returns строка с ответом для отправки в чат
 */
export function processTwitchDickCommand(twitchUsername: string): string {
  const players = loadTwitchPlayers();
  const today = getMoscowDate();
  const now = Date.now();
  const normalizedUsername = twitchUsername.toLowerCase();
  let player = players.get(normalizedUsername);
  const isFirstTime = !player;
  const canPlay = !player || canPlayTodayTwitch(player);

  if (isFirstTime) {
    const growth = generateGrowth(normalizedUsername, players);
    player = {
      twitchUsername: twitchUsername,
      size: growth,
      lastUsed: now,
      lastUsedDate: today
    };
    players.set(normalizedUsername, player);
    saveTwitchPlayers(players);

    const growthText = growth > 0 
      ? `вырос на ${growth}` 
      : growth < 0 
        ? `уменьшился на ${Math.abs(growth)}` 
        : `не изменился`;
    
    return `@${twitchUsername}, твой писюн ${growthText} см. Теперь он равен ${player.size} см. Следующая попытка завтра!`;
  } else if (canPlay && player) {
    const growth = generateGrowth(normalizedUsername, players);
    player.size += growth;
    player.lastUsed = now;
    player.lastUsedDate = today;
    player.twitchUsername = twitchUsername;
    players.set(normalizedUsername, player);
    saveTwitchPlayers(players);

    const growthText = growth > 0 
      ? `вырос на ${growth}` 
      : growth < 0 
        ? `уменьшился на ${Math.abs(growth)}` 
        : `не изменился`;

    return `@${twitchUsername}, твой писюн ${growthText} см. Теперь он равен ${player.size} см. Следующая попытка завтра!`;
  } else if (player) {
    const rank = getTwitchPlayerRank(players, normalizedUsername);

    return `@${twitchUsername}, ты уже играл. Сейчас он равен ${player.size} см. Ты занимаешь ${rank} место в топе. Следующая попытка завтра!`;
  }

  return `@${twitchUsername}, произошла ошибка при обработке команды.`;
}
