import { loadTwitchPlayers, saveTwitchPlayers, getTwitchPlayerRank, TwitchPlayerData } from '../storage/twitch-players';
import { getMoscowDate, canPlayToday } from '../utils/date';

function canPlayTodayTwitch(player: TwitchPlayerData): boolean {
  const today = getMoscowDate();
  return !player.lastUsedDate || player.lastUsedDate !== today;
}

/**
 * Генерирует значение роста с учетом специальных условий для определенных игроков
 * @param normalizedUsername - нормализованное имя пользователя
 * @param players - карта всех игроков
 * @returns значение роста
 */
function generateGrowth(normalizedUsername: string, players: Map<string, TwitchPlayerData>): number {
  const specialUsername = 'kunilika666';
  
  if (normalizedUsername === specialUsername) {
    const rank = getTwitchPlayerRank(players, normalizedUsername);
    
    if (rank > 1) {
      return Math.floor(Math.random() * 11);
    }
  }
  
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
