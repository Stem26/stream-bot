import { TwitchPlayersStorageDB } from '../../twitch-service/src/services/TwitchPlayersStorageDB';

const storage = new TwitchPlayersStorageDB();

/**
 * Команда для отображения антитопа Twitch игроков
 * @returns строка с антитопом для отправки в чат
 */
export function processTwitchBottomDickCommand(): string {
  const sortedPlayers = storage.getBottom(10);

  if (sortedPlayers.length === 0) {
    return 'Пока никто не играл в !dick на Twitch.';
  }

  let response = '💩 ТОП 10 АУТСАЙДЕРОВ НА TWITCH:';
  
  sortedPlayers.forEach((player, index) => {
    response += ` | ${index + 1}. @${player.twitchUsername} - ${player.size} см`;
  });

  return response;
}
