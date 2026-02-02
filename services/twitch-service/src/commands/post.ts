import { Telegraf } from 'telegraf';
import { BotContext } from '../types/context';
import { canUsePost } from '../utils/permissions';

// Обработчик команды /post
export async function postCommand(ctx: BotContext, bot: Telegraf<BotContext>) {
  if (!ctx.from) {
    ctx.reply('❌ Не удалось получить информацию о пользователе.');
    return;
  }

  // Проверка прав доступа - только пользователи из ALLOWED_ADMINS
  if (!canUsePost(ctx.from.id)) {
    ctx.reply('❌ У вас нет прав для использования этой команды.');
    return;
  }

  // ✨ Используем ctx.config вместо импорта!
  const channelId = ctx.config.telegram.channelId;
  
  // Проверка наличия канала
  if (!channelId) {
    ctx.reply('❌ Канал/группа не настроена! Добавьте CHANNEL_ID в файл .env');
    return;
  }

  const text = ctx.message && 'text' in ctx.message
      ? ctx.message.text.replace(/^\/post(@\w+)?\s*/i, '').trim()
      : '';

  if (!text) {
    ctx.reply('Использование: /post <текст сообщения>');
    return;
  }

  try {
    await bot.telegram.sendMessage(channelId, text);
    ctx.reply('✅ Сообщение успешно опубликовано!');
  } catch (error: any) {
    console.error('Ошибка при публикации:', error);

    if (error.response?.error_code === 400) {
      ctx.reply(
        '❌ Ошибка: Бот не является администратором или чат указан неверно.\n\n' +
        'Убедитесь, что:\n' +
        '1. Бот добавлен в группу/канал как администратор\n' +
        '2. У бота есть права на отправку сообщений\n' +
        '3. ID указан правильно (например: @my_channel или -1001234567890)\n\n' +
        '💡 Используйте /channel в группе, чтобы узнать правильный ID'
      );
    } else {
      ctx.reply(`❌ Ошибка при публикации: ${error.message}`);
    }
  }
}