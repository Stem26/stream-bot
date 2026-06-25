import { BotContext } from '../types/context';
import { playHorny } from '../actions/horny';

export async function hornyCommand(ctx: BotContext) {
  if (!ctx.from) {
    ctx.reply('❌ Не удалось получить информацию о пользователе.');
    return;
  }

  const user = ctx.from;
  const message = await playHorny(
    ctx.services.players,
    user.id,
    user.username || user.first_name || 'Неизвестный',
    user.first_name || 'Пользователь',
  );

  ctx.reply(message);
}
