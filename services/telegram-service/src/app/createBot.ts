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
  
  return bot;
}
