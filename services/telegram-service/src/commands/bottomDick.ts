import { BotContext } from '../types/context';
import { formatName } from '../utils/format';

export async function bottomDickCommand(ctx: BotContext) {
  // ✨ Используем ctx.services вместо импорта!
  const bottomPlayers = await ctx.services.players.getBottom(10);

  if (bottomPlayers.length === 0) {
    ctx.reply('📊 Топ пуст. Используйте /dick чтобы начать играть!');
    return;
  }

  let message = 'Топ 10 аутсайдеров 💩\n\n';

  bottomPlayers.forEach((player, index) => {
    const rank = index + 1;
    const name = formatName(player.firstName);
    message += `${rank} | ${name} — ${player.size} см.\n`;
  });

  ctx.reply(message);
}
