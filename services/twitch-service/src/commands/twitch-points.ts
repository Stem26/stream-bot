import { loadTwitchPlayers, TwitchPlayerData } from '../storage/twitch-players';

/**
 * Команда для отображения очков пользователя в Twitch чате
 */
export function processTwitchPointsCommand(twitchUsername: string): string {
  const players = loadTwitchPlayers();
  const normalized = twitchUsername.toLowerCase();
  const player = players.get(normalized);

  if (!player || player.points === undefined) {
    return `@${twitchUsername}, у тебя пока нет очков. Сыграй в дуэль, чтобы получить стартовые.`;
  }

  return `@${twitchUsername}, у тебя ${player.points} очков.`;
}

/**
 * Команда для отображения топ-10 по очкам в Twitch чате
 */
export function processTwitchTopPointsCommand(): string {
  const players = loadTwitchPlayers();

  if (players.size === 0) {
    return 'Пока никто не набрал очков.';
  }

  const scoredPlayers = Array.from(players.values())
    .filter((player: TwitchPlayerData) => typeof player.points === 'number');

  if (scoredPlayers.length === 0) {
    return 'Пока никто не набрал очков.';
  }

  const sortedPlayers = scoredPlayers
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    .slice(0, 10);

  let response = '🏆 ТОП 10 ПО ОЧКАМ:';
  sortedPlayers.forEach((player, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
    response += ` | ${medal} @${player.twitchUsername} - ${player.points ?? 0}`;
  });

  return response;
}
