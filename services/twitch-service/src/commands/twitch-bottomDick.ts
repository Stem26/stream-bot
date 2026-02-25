import { TwitchPlayersStorageDB } from '../services/TwitchPlayersStorageDB';

const storage = new TwitchPlayersStorageDB();

export async function processTwitchBottomDickCommand(): Promise<string> {
  const sortedPlayers = await storage.getBottom(10);

  if (sortedPlayers.length === 0) {
    return 'Пока никто не играл в !dick на Twitch.';
  }

  let response = '💩 ТОП 10 АУТСАЙДЕРОВ НА TWITCH:';
  sortedPlayers.forEach((player, index) => {
    response += ` | ${index + 1}. @${player.twitchUsername} - ${player.size} см`;
  });

  return response;
}
