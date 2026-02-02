import { BotContext } from '../types/context';
import { getMoscowDate, canUseFutureToday } from '../utils/date';
import { predictions } from '../utils/predictions';
import { getAvailablePredictions, addToHistory, clearHistory } from '../utils/futureHistory';

export function futureCommand(ctx: BotContext) {
  if (!ctx.from) {
    ctx.reply('❌ Не удалось получить информацию о пользователе.');
    return;
  }

  const user = ctx.from;
  const userId = user.id;
  const username = user.username || user.first_name || 'Неизвестный';
  const firstName = user.first_name || 'Пользователь';
  const today = getMoscowDate();

  let player = ctx.services.players.get(userId);

  if (!player) {
    player = {
      userId: userId,
      username: username,
      firstName: firstName,
      size: 0,
      lastUsed: 0,
      lastUsedDate: ''
    };
  }

  if (player.lastFutureDate !== today) {
    player.futureAttemptsToday = 0;
  }

  const canUse = canUseFutureToday(player);
  const attempts = player.futureAttemptsToday || 0;

  if (canUse) {
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
    ctx.services.players.set(userId, player);

    ctx.reply(`"${prediction}"\n\n`);
  } else {
    player.futureAttemptsToday = (attempts + 1);
    player.username = username;
    player.firstName = firstName;
    ctx.services.players.set(userId, player);

    if (attempts === 1) {
      ctx.reply(`@${username}, ты уже получал предсказание сегодня.\nСледующая попытка завтра!`);
    } else if (attempts === 2) {
      ctx.reply(`Серьёзно? Ещё раз? Завтра это не сегодня, понял?`);
    } else if (attempts === 3) {
      ctx.reply(`Ой, дурак... читать не умеешь?`);
    } else {
      return;
    }
  }
}
