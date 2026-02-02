import { BotContext } from '../types/context';

const processedMessages = new Set<number>();

/**
 * Команда /dick - тонкая обертка над DickService
 */
export function dickCommand(ctx: BotContext) {
  if (!ctx.from) {
    ctx.reply('❌ Не удалось получить информацию о пользователе.');
    return;
  }

  // Защита от дублирования сообщений
  const messageId = ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : null;
  if (messageId && processedMessages.has(messageId)) {
    return;
  }
  if (messageId) {
    processedMessages.add(messageId);
    if (processedMessages.size > 1000) {
      const firstId = Array.from(processedMessages)[0];
      processedMessages.delete(firstId);
    }
  }

  const user = ctx.from;
  const userId = user.id;
  const username = user.username || user.first_name || 'Неизвестный';
  const firstName = user.first_name || 'Пользователь';

  // ✨ Вся бизнес-логика в сервисе!
  const result = ctx.services.dick.play(userId, username, firstName);
  
  // Команда только отправляет сообщение
  ctx.reply(result.message);
}
