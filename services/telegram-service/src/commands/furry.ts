import { BotContext } from '../types/context';
import { getMoscowDate, canUseFurryToday } from '../utils/date';

export async function furryCommand(ctx: BotContext) {
  if (!ctx.from) {
    ctx.reply('❌ Не удалось получить информацию о пользователе.');
    return;
  }

  const user = ctx.from;
  const userId = user.id;
  const username = user.username || user.first_name || 'Неизвестный';
  const firstName = user.first_name || 'Пользователь';
  const today = getMoscowDate();

  let player = await ctx.services.players.get(userId);

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

  const canUse = canUseFurryToday(player);
  const isStreamer = ctx.config.streamerUserIds.includes(userId);

  if (canUse) {
    let percentage: number;
    if (isStreamer) {
      percentage = Math.random() < 0.1 ? 100 : -100;
    } else {
      percentage = Math.floor(Math.random() * 101);
    }
    player.lastFurryDate = today;
    player.username = username;
    player.firstName = firstName;
    await ctx.services.players.set(userId, player);

    ctx.reply(`@${username} ты сегодня фури на ${percentage}%\nСледующая попытка завтра!`);
  } else {
    ctx.reply(`@${username}, ты уже проверял свой уровень фури сегодня.\nСледующая попытка завтра!`);
  }
}
