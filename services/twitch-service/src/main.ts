import { NightBotMonitor } from './services/nightbot-monitor';
import { TwitchStreamMonitor } from './services/twitch-stream-monitor';
import { Telegraf } from 'telegraf';
import { loadConfig } from './config/env';

async function main() {
  const config = loadConfig();

  console.log('🚀 Запуск Twitch сервиса...');

  // Telegram client (без polling!)
  const telegramBot = new Telegraf(config.telegram.token);

  // Monitor stream online/offline -> отправляет уведомления в TG + announcement в Twitch
  const streamMonitor = new TwitchStreamMonitor(telegramBot.telegram);

  await streamMonitor.connect(
    config.twitch.channel,
    config.twitch.accessToken,
    config.twitch.clientId,
    config.telegram.channelId
  );

  // Chat monitor / commands / moderation
  const nightBotMonitor = new NightBotMonitor();

  // Связываем проверку статуса стрима: команды работают только когда стрим онлайн
  nightBotMonitor.setStreamStatusCheck(() => streamMonitor.getStreamStatus());

  await nightBotMonitor.connect(
    config.twitch.channel,
    config.twitch.accessToken,
    config.twitch.clientId
  );

  console.log('✅ Twitch сервис запущен');
}

main().catch((err) => {
  console.error('❌ Twitch service fatal error:', err);
  process.exit(1);
});