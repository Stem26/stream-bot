import { loadTwitchPlayers } from '../storage/twitch-players';

/**
 * Команда для отображения антитопа Twitch игроков
 * @returns строка с антитопом для отправки в чат
 */
export function processTwitchBottomDickCommand(): string {
  const players = loadTwitchPlayers();
  if (players.size === 0) {
    return 'Пока никто не играл в !dick на Twitch.';
  }

  const sortedPlayers = Array.from(players.values())
    .sort((a, b) => a.size - b.size)
    .slice(0, 10); // Берем топ 10 аутсайдеров

  let response = '💩 ТОП 10 АУТСАЙДЕРОВ НА TWITCH:';
  
  sortedPlayers.forEach((player, index) => {
    response += ` | ${index + 1}. @${player.twitchUsername} - ${player.size} см`;
  });

  return response;
}
