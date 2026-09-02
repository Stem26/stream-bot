import { BotContext } from '../types/context';
import { getMoscowDate, canUseAllToday } from '../utils/date';
import { playHorny } from '../actions/horny';
import { playFurry } from '../actions/furry';
import { playFuture } from '../actions/future';
import { getOrCreatePlayer } from '../actions/player';
import { displayName } from '../utils/format';

export async function allCommand(ctx: BotContext) {
  if (!ctx.from) {
    ctx.reply('❌ Не удалось получить информацию о пользователе.');
    return;
  }

  const user = ctx.from;
  const userId = user.id;
  const username = user.username || user.first_name || 'Неизвестный';
  const firstName = user.first_name || 'Пользователь';
  const today = getMoscowDate();

  const existingPlayer = await ctx.services.players.get(userId);
  if (existingPlayer && !canUseAllToday(existingPlayer)) {
    ctx.reply(`${displayName(firstName)}, ты уже использовал /all сегодня.\nСледующая попытка завтра!`);
    return;
  }

  const dickResult = await ctx.services.dick.play(userId, username, firstName);
  const hornyResult = await playHorny(ctx.services.players, userId, username, firstName);
  const furryResult = await playFurry(
    ctx.services.players,
    userId,
    username,
    firstName,
    ctx.config.streamerUserIds,
  );
  const futureResult = await playFuture(ctx.services.players, userId, username, firstName, {
    countAsRetry: false,
  });

  const player = await getOrCreatePlayer(ctx.services.players, userId, username, firstName);
  player.lastAllDate = today;
  player.username = username;
  player.firstName = firstName;
  await ctx.services.players.set(userId, player);

  const sections = [
    `📏 Dick\n${dickResult.message}`,
    `🔮 Future\n${futureResult ?? '—'}`,
    `😈 Horny\n${hornyResult}`,
    `🐾 Furry\n${furryResult}`,
  ];

  ctx.reply(sections.join('\n\n'));
}
