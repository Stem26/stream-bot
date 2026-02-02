import { Telegraf } from 'telegraf';
import { BotContext } from '../types/context';

/**
 * Настраивает middleware и обработчики для бота
 * 
 * Примечание: Глобальные обработчики ошибок настраиваются в errorHandlers.ts
 */
export function setupMiddlewares(bot: Telegraf<BotContext>): void {
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
