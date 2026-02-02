import { Telegraf } from 'telegraf';
import { BotContext } from '../types/context';

// Примечание: Используем console.log/error, так как logger может быть не инициализирован
// при загрузке этого модуля

/**
 * Настраивает глобальные обработчики ошибок для бота и процесса
 */
export function setupErrorHandlers(bot: Telegraf<BotContext>) {
  // ===== 1. Обработчик ошибок Telegraf =====
  bot.catch((err: any, ctx: BotContext) => {
    console.error('❌ Ошибка обработки Telegram update:', {
      error: err.message,
      updateType: ctx.updateType,
      userId: ctx.from?.id,
      username: ctx.from?.username,
      chatId: ctx.chat?.id,
      chatType: ctx.chat?.type,
      messageText: ctx.message && 'text' in ctx.message ? ctx.message.text : undefined
    });

    // Пытаемся сообщить пользователю об ошибке
    try {
      ctx.reply('❌ Произошла ошибка при обработке команды. Попробуйте позже.');
    } catch (replyError) {
      console.error('Не удалось отправить сообщение об ошибке пользователю:', replyError);
    }
  });

  // ===== 2. Unhandled Promise Rejections =====
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    console.error('🚨 Unhandled Promise Rejection:', {
      error: reason,
      promise: promise.toString()
    });

    // В продакшене можно отправить уведомление админам
    // notifyAdmins(bot, 'Unhandled Promise Rejection', reason);
  });

  // ===== 3. Uncaught Exceptions =====
  process.on('uncaughtException', (err: Error, origin: string) => {
    console.error('💥 Uncaught Exception - критическая ошибка!', {
      error: err.message,
      stack: err.stack,
      origin
    });

    // Даем время залогировать ошибку перед выходом
    setTimeout(() => {
      console.error('Процесс завершается из-за критической ошибки');
      process.exit(1);
    }, 1000);
  });

  console.log('✅ Глобальные обработчики ошибок настроены');
}

/**
 * Вспомогательная функция для уведомления админов о критических ошибках
 * (опционально, можно включить в продакшене)
 */
export async function notifyAdmins(
  bot: Telegraf<BotContext>,
  title: string,
  error: any
) {
  const adminIds = process.env.ALLOWED_ADMINS?.split(',').map(id => parseInt(id.trim())) || [];
  
  if (adminIds.length === 0) {
    return;
  }

  const message = `
🚨 <b>${title}</b>

<b>Ошибка:</b> <code>${error?.message || String(error)}</code>

<b>Время:</b> ${new Date().toLocaleString('ru-RU')}
  `.trim();

  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, message, {
        parse_mode: 'HTML'
      });
    } catch (err) {
      console.error('Не удалось отправить уведомление админу:', { err, adminId });
    }
  }
}

/**
 * Обработчик ошибок для async функций
 * Оборачивает функцию в try-catch и логирует ошибки
 */
export function asyncErrorHandler<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  context?: string
): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      console.error('Ошибка в async функции:', { error, context });
      throw error;
    }
  }) as T;
}

/**
 * Retry wrapper для функций, которые могут упасть
 */
export async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000,
  context?: string
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries) {
        console.warn(`Попытка ${attempt} не удалась, повторяем через ${delayMs}мс...`, {
          attempt,
          maxRetries,
          delayMs,
          context,
          error
        });
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error(`Все ${maxRetries} попытки не удались`, {
    maxRetries,
    context,
    error: lastError
  });
  
  throw lastError;
}
