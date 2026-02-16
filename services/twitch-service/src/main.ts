import { NightBotMonitor } from './services/nightbot-monitor';
import { TwitchStreamMonitor } from './services/twitch-stream-monitor';
import { Telegraf } from 'telegraf';
import { loadConfig } from './config/env';
import { clearDuelQueue } from "./commands/twitch-duel";
import { clearActiveUsers } from "./commands/twitch-rat";

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

    // Связываем синхронизацию viewers: при запросе chatters сразу запрашиваем viewers для точности пика
    nightBotMonitor.setSyncViewersCallback((chattersCount) => streamMonitor.recordViewersNow(chattersCount));

    // Очищаем очередь на дуэли, активных пользователей и счётчики при окончании стрима
    streamMonitor.setOnStreamOfflineCallback(() => {
        clearDuelQueue();
        clearActiveUsers(config.twitch.channel);
        nightBotMonitor.clearChattersCache();
        nightBotMonitor.clearStopCounters();
        nightBotMonitor.clearDeathCounters();
    });

    await nightBotMonitor.connect(
        config.twitch.channel,
        config.twitch.accessToken,
        config.twitch.clientId
    );

    // Связываем streamMonitor с chatClient для отправки приветственных сообщений
    streamMonitor.setChatSender(
        (channel, message) => nightBotMonitor.sendMessage(channel, message),
        config.twitch.channel
    );

    console.log('✅ Twitch сервис запущен');

    // Graceful shutdown
    const shutdown = async (signal: string) => {
        console.log(`\n⚠️ Получен сигнал ${signal}, завершаем работу...`);
        
        try {
            console.log('🛑 Отключаем NightBot мониторинг...');
            await nightBotMonitor.disconnect();
            
            console.log('🛑 Отключаем Stream мониторинг...');
            await streamMonitor.disconnect();
            
            console.log('✅ Все соединения закрыты');
            process.exit(0);
        } catch (error) {
            console.error('❌ Ошибка при завершении:', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));
}

main().catch((err) => {
    console.error('❌ Twitch service fatal error:', err);
    process.exit(1);
});