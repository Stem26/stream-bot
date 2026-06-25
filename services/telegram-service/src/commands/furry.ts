import { BotContext } from '../types/context';
import { playFurry } from '../actions/furry';

export async function furryCommand(ctx: BotContext) {
  if (!ctx.from) {
    ctx.reply('❌ Не удалось получить информацию о пользователе.');
    return;
  }

  const user = ctx.from;
  const message = await playFurry(
    ctx.services.players,
    user.id,
    user.username || user.first_name || 'Неизвестный',
    user.first_name || 'Пользователь',
    ctx.config.streamerUserIds,
  );

  ctx.reply(message);
}
