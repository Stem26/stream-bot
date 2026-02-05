import { Telegraf } from 'telegraf';
import { BotContext } from '../types/context';

// Время запуска бота (в секундах, как в Telegram API)
const BOT_START_TIME = Math.floor(Date.now() / 1000);

/**
 * Настраивает middleware и обработчики для бота
 * 
 * Примечание: Глобальные обработчики ошибок настраиваются в errorHandlers.ts
 */
export function setupMiddlewares(bot: Telegraf<BotContext>): void {
  // Игнорируем сообщения, отправленные до запуска бота (тихо)
  bot.use((ctx, next) => {
    const messageDate = ctx.message?.date || ctx.callbackQuery?.message?.date || 0;
    if (messageDate < BOT_START_TIME) return;
    return next();
  });
  // Обработчик текстовых сообщений (не команд)
  bot.on('text', (context: BotContext) => {
    const message = context.message && 'text' in context.message ? context.message.text : '';

    // Игнорируем команды
    if (message.startsWith('/')) {
      return;
    }

    // Игнорируем ответы на сообщения
    if (context.message && 'reply_to_message' in context.message && context.message.reply_to_message) {
      return;
    }

    // Отвечаем только в личных чатах
    if (context.chat && context.chat.type !== 'private') {
      return;
    }

    context.reply(
      `Вы написали: ${message}\n\n` +
      'Используйте /help чтобы увидеть список команд.'
    );
  });

  console.log('✅ Middleware настроены');
}
