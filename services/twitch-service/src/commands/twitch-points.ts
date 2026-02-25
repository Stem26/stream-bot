import { TwitchPlayersStorageDB } from '../services/TwitchPlayersStorageDB';

const storage = new TwitchPlayersStorageDB();

export async function processTwitchPointsCommand(twitchUsername: string): Promise<string> {
  const players = await storage.loadTwitchPlayers();
  const normalized = twitchUsername.toLowerCase();
  const player = players.get(normalized);

  if (!player || player.points === undefined) {
    return `@${twitchUsername}, у тебя пока нет очков. Сыграй в дуэль, чтобы получить стартовые.`;
  }

  let response = `@${twitchUsername}, 💰 ${player.points} очков`;

  const wins = player.duelWins ?? 0;
  const losses = player.duelLosses ?? 0;
  const draws = player.duelDraws ?? 0;
  const totalDuels = wins + losses + draws;

  if (totalDuels > 0) {
    const winRate = Math.round((wins / totalDuels) * 100);
    const lossRate = Math.round((losses / totalDuels) * 100);
    const drawRate = Math.round((draws / totalDuels) * 100);
    response += ` | Побед: ${wins} (${winRate}%) | Поражений: ${losses} (${lossRate}%) | Ничьих: ${draws} (${drawRate}%)`;
  }

  return response;
}

export async function processTwitchTopPointsCommand(): Promise<string> {
  const sortedPlayers = await storage.getTopPoints(10);

  if (sortedPlayers.length === 0) {
    return 'Пока никто не набрал очков.';
  }

  let response = '🏆 ТОП 10 ПО ОЧКАМ:';
  sortedPlayers.forEach((player, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
    response += ` | ${medal} @${player.twitchUsername} - ${player.points ?? 1000}`;
  });

  return response;
}
