import './utils/console-msk';
import { NightBotMonitor } from './services/nightbot-monitor';
import { TwitchEventSubNative } from './services/twitch-eventsub-native';
import { Telegraf } from 'telegraf';
import { loadConfig } from './config/env';
import { clearDuelQueue, resetDuelsOnStreamEnd, clearDuelChallenges } from "./commands/twitch-duel";
import { clearActiveUsers } from "./commands/twitch-rat";
import { log } from './utils/event-logger';
import { initDatabase, closeDatabase } from './database/database';
import { startWebServer, setOnCommandsChangedCallback, setOnCommandExecuteCallback, setOnLinksSendCallback, setOnEnableDuelsCallback, setOnDisableDuelsCallback, setOnPardonAllCallback, setGetDuelsStatusCallback } from './web/server';

async function main() {
    const config = loadConfig();

    console.log('🚀 Запуск Twitch сервиса...');
    log('BOT_START', {
        version: process.env.npm_package_version || 'unknown',
        nodeVersion: process.version,
        platform: process.platform
    });

    // Инициализация базы данных
    console.log('📦 Инициализация базы данных...');
    try {
        await initDatabase();
        console.log('✅ База данных готова');
    } catch (error) {
        console.error('❌ Ошибка инициализации БД:', error);
        throw error;
    }

    // Запуск веб-сервера для управления командами
    console.log('🌐 Запуск веб-интерфейса...');
    try {
        await startWebServer();
        console.log('✅ Веб-интерфейс запущен');
    } catch (error) {
        console.error('❌ Ошибка запуска веб-сервера:', error);
        // Не падаем если веб-сервер не запустился - бот может работать без него
    }

    // Telegram client (без polling!)
    const telegramBot = new Telegraf(config.telegram.token);

    // Monitor stream online/offline -> отправляет уведомления в TG + announcement в Twitch
    const streamMonitor = new TwitchEventSubNative(telegramBot.telegram);

    await streamMonitor.connect(
        config.twitch.channel,
        config.twitch.accessToken,
        config.twitch.clientId,
        config.telegram.channelId,
        config.telegram.chatId
    );

    // Chat monitor / commands / moderation
    const nightBotMonitor = new NightBotMonitor();

    // Устанавливаем колбэк для перезагрузки команд, счётчиков и ссылок при изменениях через веб-интерфейс
    setOnCommandsChangedCallback(() => {
        nightBotMonitor.reloadCustomCommands();
        nightBotMonitor.reloadCounters();
        nightBotMonitor.reloadLinksConfig();
    });

    // Колбэк для ручного запуска команды из веб-интерфейса
    setOnCommandExecuteCallback(async (id: string) => {
        await nightBotMonitor.executeCustomCommandById(id);
    });

    // Колбэк для ручной отправки !ссылки из веб-интерфейса
    setOnLinksSendCallback(async () => {
        await nightBotMonitor.executeLinksFromUi();
    });

    // Колбэки для админ-панели
    setOnEnableDuelsCallback(() => {
        nightBotMonitor.enableDuelsFromWeb();
    });

    setOnDisableDuelsCallback(() => {
        nightBotMonitor.disableDuelsFromWeb();
    });

    setOnPardonAllCallback(async () => {
        await nightBotMonitor.pardonAllFromWeb();
    });

    setGetDuelsStatusCallback(() => {
        return nightBotMonitor.getDuelsStatus();
    });

    // Связываем проверку статуса стрима: команды работают только когда стрим онлайн
    nightBotMonitor.setStreamStatusCheck(() => streamMonitor.getStreamStatus());

    // Связываем синхронизацию viewers: при запросе chatters сразу запрашиваем viewers для точности пика
    nightBotMonitor.setSyncViewersCallback((chattersCount) => streamMonitor.recordViewersNow(chattersCount));

    // Запускаем синхронизацию зрителей при начале стрима
    streamMonitor.setOnStreamOnlineCallback(() => {
        nightBotMonitor.startViewersSync();
        nightBotMonitor.enableCountersOnStreamStart();
        nightBotMonitor.enableDuelsFromWeb();
    });

    // Очищаем очередь на дуэли, активных пользователей и счётчики при окончании стрима
    streamMonitor.setOnStreamOfflineCallback(() => {
        clearDuelQueue();
        clearDuelChallenges();
        resetDuelsOnStreamEnd();
        clearActiveUsers(config.twitch.channel);
        nightBotMonitor.clearChattersCache();
        nightBotMonitor.clearStopCounters();
        nightBotMonitor.clearDeathCounters();
        nightBotMonitor.clearDetectedModerators();
        nightBotMonitor.disableDuelsFromWeb();
        nightBotMonitor.stopViewersSync();
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
        log('BOT_STOP', { reason: signal });
        
        try {
            console.log('🛑 Отключаем NightBot мониторинг...');
            await nightBotMonitor.disconnect();
            
            console.log('🛑 Отключаем Stream мониторинг...');
            await streamMonitor.disconnect();
            
            console.log('🛑 Закрываем соединение с базой данных...');
            await closeDatabase();
            
            console.log('✅ Все соединения закрыты');
            process.exit(0);
        } catch (error: any) {
            console.error('❌ Ошибка при завершении:', error);
            log('ERROR', {
                context: 'shutdown',
                error: error?.message || String(error),
                stack: error?.stack
            });
            await closeDatabase(); // Закрываем БД даже при ошибке
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));
}

main().catch((err: any) => {
    console.error('❌ Twitch service fatal error:', err);
    log('ERROR', {
        context: 'main',
        error: err?.message || String(err),
        stack: err?.stack,
        fatal: true
    });
    process.exit(1);
});