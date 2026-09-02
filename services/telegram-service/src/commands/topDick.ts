import { BotContext } from '../types/context';
import { displayName } from '../utils/format';

export async function topDickCommand(ctx: BotContext) {
  // ✨ Используем ctx.services вместо импорта!
  const topPlayers = await ctx.services.players.getTop(10);

  if (topPlayers.length === 0) {
    ctx.reply('📊 Топ пуст. Используйте /dick чтобы начать играть!');
    return;
  }

  let message = 'Топ 10 игроков\n\n';

  topPlayers.forEach((player, index) => {
    const rank = index + 1;
    const name = displayName(player.firstName);
    message += `${rank} | ${name} — ${player.size} см.\n`;
  });

  ctx.reply(message);
}
