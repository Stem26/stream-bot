import { Telegraf } from 'telegraf';
import { BotContext, AppServices } from '../types/context';
import { AppConfig } from '../types/config';
import * as dns from 'dns';

/**
 * Создает и настраивает экземпляр Telegraf бота с DI
 */
export function createBot(config: AppConfig, services: AppServices): Telegraf<BotContext> {
  dns.setDefaultResultOrder('ipv4first');

  const bot = new Telegraf<BotContext>(config.botToken);
  
  bot.use(async (ctx, next) => {
    ctx.services = services;
    ctx.config = config;
    await next();
  });

  // Отвечаем реплаем на сообщение с командой, без @тега в тексте.
  bot.use(async (ctx, next) => {
    const messageId =
      ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : undefined;
    if (!messageId) {
      await next();
      return;
    }

    const originalReply = ctx.reply.bind(ctx);
    ctx.reply = ((text: string, extra?: Record<string, unknown>) => {
      return originalReply(text, {
        ...extra,
        reply_to_message_id: extra?.reply_to_message_id ?? messageId,
      } as Parameters<typeof originalReply>[1]);
    }) as typeof ctx.reply;

    await next();
  });
  
  return bot;
}
