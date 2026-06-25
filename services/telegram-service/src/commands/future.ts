import { BotContext } from '../types/context';
import { playFuture } from '../actions/future';

export async function futureCommand(ctx: BotContext) {
  if (!ctx.from) {
    ctx.reply('❌ Не удалось получить информацию о пользователе.');
    return;
  }

  const user = ctx.from;
  const message = await playFuture(
    ctx.services.players,
    user.id,
    user.username || user.first_name || 'Неизвестный',
    user.first_name || 'Пользователь',
  );

  if (message) {
    ctx.reply(message);
  }
}
