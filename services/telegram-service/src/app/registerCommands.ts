import { Telegraf } from 'telegraf';
import { BotContext } from '../types/context';
import { commands, getMenuCommands, canAccessCommand } from '../commands';

/**
 * Регистрирует все команды бота
 * Включает проверку прав доступа для adminOnly команд
 */
export function registerCommands(bot: Telegraf<BotContext>): void {
  for (const cmd of commands) {
    bot.command(cmd.name, async (ctx) => {
      if (!canAccessCommand(cmd, ctx)) {
        ctx.reply('❌ У вас нет доступа к этой команде.');
        return;
      }
      
      await cmd.handler(ctx, bot);
    });
  }
  
  console.log(`✅ Зарегистрировано ${commands.length} команд`);
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
