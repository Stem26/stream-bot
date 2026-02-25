import { TwitchPlayersStorageDB } from '../services/TwitchPlayersStorageDB';

const storage = new TwitchPlayersStorageDB();

/**
 * Команда для отображения очков пользователя в Twitch чате
 */
export function processTwitchPointsCommand(twitchUsername: string): string {
  const players = storage.loadTwitchPlayers();
  const normalized = twitchUsername.toLowerCase();
  const player = players.get(normalized);

  if (!player || player.points === undefined) {
    return `@${twitchUsername}, у тебя пока нет очков. Сыграй в дуэль, чтобы получить стартовые.`;
  }

  // Формируем базовую информацию об очках
  let response = `@${twitchUsername}, 💰 ${player.points} очков`;

  // Добавляем статистику дуэлей, если есть хотя бы одна дуэль
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

/**
 * Команда для отображения топ-10 по очкам в Twitch чате
 */
export function processTwitchTopPointsCommand(): string {
  const sortedPlayers = storage.getTopPoints(10);

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
