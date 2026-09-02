import { PlayersStorageDB } from '../services/PlayersStorageDB';
import { getMoscowDate, canUseFurryToday } from '../utils/date';
import { displayName } from '../utils/format';
import { getOrCreatePlayer } from './player';

export async function playFurry(
  players: PlayersStorageDB,
  userId: number,
  username: string,
  firstName: string,
  streamerUserIds: number[],
): Promise<string> {
  const today = getMoscowDate();
  const player = await getOrCreatePlayer(players, userId, username, firstName);

  const name = displayName(firstName);

  if (!canUseFurryToday(player)) {
    return `${name}, ты уже проверял свой уровень фури сегодня.\nСледующая попытка завтра!`;
  }

  const isStreamer = streamerUserIds.includes(userId);
  let percentage: number;
  if (isStreamer) {
    percentage = Math.random() < 0.1 ? 100 : -100;
  } else {
    percentage = Math.floor(Math.random() * 101);
  }

  player.lastFurryDate = today;
  player.username = username;
  player.firstName = firstName;
  await players.set(userId, player);

  return `${name}, ты сегодня фури на ${percentage}%\nСледующая попытка завтра!`;
}
