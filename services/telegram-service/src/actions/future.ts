import { PlayersStorageDB } from '../services/PlayersStorageDB';
import { getMoscowDate, canUseFutureToday } from '../utils/date';
import { getAvailablePredictions, addToHistory, clearHistory } from '../utils/futureHistory';
import { getActiveFuturePredictions } from '../services/future-predictions';
import { getOrCreatePlayer } from './player';

export interface PlayFutureOptions {
  /** Увеличивать счётчик повторных попыток (для /future). В /all — false. */
  countAsRetry?: boolean;
}

export async function playFuture(
  players: PlayersStorageDB,
  userId: number,
  username: string,
  firstName: string,
  options: PlayFutureOptions = {},
): Promise<string | null> {
  const { countAsRetry = true } = options;
  const today = getMoscowDate();
  const player = await getOrCreatePlayer(players, userId, username, firstName);

  if (player.lastFutureDate !== today) {
    player.futureAttemptsToday = 0;
  }

  const canUse = canUseFutureToday(player);
  const attempts = player.futureAttemptsToday || 0;

  if (canUse) {
    const predictions = await getActiveFuturePredictions();
    let availablePredictions = getAvailablePredictions(predictions);

    if (availablePredictions.length === 0) {
      clearHistory();
      availablePredictions = predictions;
    }

    const randomIndex = Math.floor(Math.random() * availablePredictions.length);
    const prediction = availablePredictions[randomIndex];

    addToHistory(prediction);

    player.lastFutureDate = today;
    player.futureAttemptsToday = 1;
    player.username = username;
    player.firstName = firstName;
    await players.set(userId, player);

    return prediction;
  }

  if (!countAsRetry) {
    return `Ты уже получал предсказание сегодня.\nСледующая попытка завтра!`;
  }

  player.futureAttemptsToday = attempts + 1;
  player.username = username;
  player.firstName = firstName;
  await players.set(userId, player);

  if (attempts === 1) {
    return `Ты уже получал предсказание сегодня.\nСледующая попытка завтра!`;
  }
  if (attempts === 2) {
    return 'Серьёзно? Ещё раз? Завтра это не сегодня, понял?';
  }
  if (attempts === 3) {
    return 'Ой, дурак... читать не умеешь?';
  }

  return null;
}
