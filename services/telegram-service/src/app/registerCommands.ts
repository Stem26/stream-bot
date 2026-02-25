import { Telegraf } from 'telegraf';
import { BotContext } from '../types/context';
import { commands, getMenuCommands, canAccessCommand } from '../commands';

/**
 * Регистрирует все команды бота
 * Включает проверку прав доступа для adminOnly команд
 */
export function registerCommands(bot: Telegraf<BotContext>): void {
  // Команда /myid — показать свой ID (доступна всем)
  bot.command('myid', async (ctx) => {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    const firstName = ctx.from?.first_name;
    
    ctx.reply(
      `👤 Ваша информация:\n\n` +
      `ID: <code>${userId}</code>\n` +
      `Username: ${username ? '@' + username : 'не установлен'}\n` +
      `Имя: ${firstName || 'не установлено'}`,
      { parse_mode: 'HTML' }
    );
  });

  for (const cmd of commands) {
    bot.command(cmd.name, async (ctx) => {
      if (!canAccessCommand(cmd, ctx)) {
        ctx.reply('❌ У вас нет доступа к этой команде.');
        return;
      }
      
      await cmd.handler(ctx, bot);
    });
  }
  
  console.log(`✅ Зарегистрировано ${commands.length + 1} команд`);
}

/**
 * Настраивает команды в Telegram (для автокомплита)
 * Использует тот же фильтр, что и help
 */
export async function setupBotCommands(bot: Telegraf<BotContext>): Promise<void> {
  const menuCommands = getMenuCommands();

  await bot.telegram.setMyCommands(menuCommands);

  console.log(`✅ Настроено ${menuCommands.length} команд в меню Telegram`);
}
