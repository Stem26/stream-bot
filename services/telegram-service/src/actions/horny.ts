import { PlayersStorageDB } from '../services/PlayersStorageDB';
import { getMoscowDate, canUseHornyToday } from '../utils/date';
import { getOrCreatePlayer } from './player';

export async function playHorny(
  players: PlayersStorageDB,
  userId: number,
  username: string,
  firstName: string,
): Promise<string> {
  const today = getMoscowDate();
  const player = await getOrCreatePlayer(players, userId, username, firstName);

  if (!canUseHornyToday(player)) {
    return `@${username}, ты уже проверял свой уровень хорни сегодня.\nСледующая попытка завтра!`;
  }

  const percentage = Math.floor(Math.random() * 101);
  player.lastHornyDate = today;
  player.username = username;
  player.firstName = firstName;
  await players.set(userId, player);

  return `@${username} ты сегодня хорни на ${percentage}%\nСледующая попытка завтра!`;
}
