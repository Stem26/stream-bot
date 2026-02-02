import { BotContext } from '../types/context';
import { getMoscowDate, canUseHornyToday } from '../utils/date';

// Обработчик команды /horny
export function hornyCommand(ctx: BotContext) {
  if (!ctx.from) {
    ctx.reply('❌ Не удалось получить информацию о пользователе.');
    return;
  }

  const user = ctx.from;
  const userId = user.id;
  const username = user.username || user.first_name || 'Неизвестный';
  const firstName = user.first_name || 'Пользователь';
  const today = getMoscowDate();

  // ✨ Используем ctx.services
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

  const canUse = canUseHornyToday(player);

  if (canUse) {
    const percentage = Math.floor(Math.random() * 101);
    player.lastHornyDate = today;
    player.username = username;
    player.firstName = firstName;
    ctx.services.players.set(userId, player);

    ctx.reply(`@${username} ты сегодня хорни на ${percentage}%\nСледующая попытка завтра!`);
  } else {
    ctx.reply(`@${username}, ты уже проверял свой уровень хорни сегодня.\nСледующая попытка завтра!`);
  }
}
