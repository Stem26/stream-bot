import './utils/console-msk';
import { NightBotMonitor } from './services/nightbot-monitor';
import { TwitchEventSubNative } from './services/twitch-eventsub-native';
import { Telegraf } from 'telegraf';
import { loadConfig } from './config/env';
import { clearDuelQueue, resetDuelsOnStreamEnd, resetDuelStreamProgressOnStreamEnd, clearDuelChallenges, setOnDuelBannedListChanged, setDuelConfig, setDailyQuestConfig, initRaidDuelBoostsFromDb, clearAllRaidDuelBoosts, registerRaidDuelBoostFromRaidEvent } from "./commands/twitch-duel";
import { clearActiveUsers } from "./commands/twitch-rat";
import { log } from './utils/event-logger';
import { initDatabase, closeDatabase, query, queryOne } from './database/database';
import { startWebServer, getBroadcastDuelBannedChanged, setOnCommandsChangedCallback, setOnCommandExecuteCallback, setOnLinksSendCallback, setOnEnableDuelsCallback, setOnDisableDuelsCallback, setOnPardonAllCallback, setGetDuelBannedListCallback, setPardonDuelUserCallback, setGetDuelsStatusCallback, setGetDuelCooldownSkipCallback, setSetDuelCooldownSkipCallback, setGetDuelOverlaySyncEnabledCallback, setSetDuelOverlaySyncEnabledCallback, setOnDuelConfigUpdatedCallback, setOnDuelDailyConfigUpdatedCallback, setOnLinksConfigUpdatedCallback, setOnRaidConfigUpdatedCallback, setOnChatModerationConfigUpdatedCallback, setOnPartyConfigUpdatedCallback, setOnFriendsShoutoutConfigUpdatedCallback, getRaidMessageFromDb } from './web/server';

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
        try {
            const duelConfigRow = await queryOne<{
                timeout_minutes: number;
                win_points: number;
                loss_points: number;
                miss_penalty: number;
                raid_duel_boost_enabled?: boolean;
                raid_duel_boost_win_percent?: number;
                raid_duel_boost_duration_minutes?: number;
                raid_duel_boost_min_viewers?: number;
            }>(
                'SELECT timeout_minutes, win_points, loss_points, miss_penalty, raid_duel_boost_enabled, raid_duel_boost_win_percent, raid_duel_boost_duration_minutes, raid_duel_boost_min_viewers FROM duel_config WHERE id = 1'
            );
            if (duelConfigRow) {
                setDuelConfig({
                    timeoutMinutes: duelConfigRow.timeout_minutes,
                    winPoints: duelConfigRow.win_points,
                    lossPoints: duelConfigRow.loss_points,
                    missPenalty: duelConfigRow.miss_penalty ?? 5,
                    raidBoostEnabled: duelConfigRow.raid_duel_boost_enabled ?? false,
                    raidBoostWinPercent: duelConfigRow.raid_duel_boost_win_percent ?? 70,
                    raidBoostDurationMinutes: duelConfigRow.raid_duel_boost_duration_minutes ?? 10,
                    raidBoostMinViewers: duelConfigRow.raid_duel_boost_min_viewers ?? 5,
                });
            }
            const dailyRow = await queryOne<{ daily_games_count: number; daily_reward_points: number; streak_wins_count: number; streak_reward_points: number }>(
                'SELECT daily_games_count, daily_reward_points, streak_wins_count, streak_reward_points FROM duel_daily_config WHERE id = 1'
            );
            if (dailyRow) {
                setDailyQuestConfig({
                    dailyGamesCount: dailyRow.daily_games_count,
                    dailyRewardPoints: dailyRow.daily_reward_points,
                    streakWinsCount: dailyRow.streak_wins_count,
                    streakRewardPoints: dailyRow.streak_reward_points,
                });
            }
        } catch (_) {
            // таблицы могут отсутствовать в dev без БД
        }
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

    // Провайдер ротации должен быть задан ДО connect(): иначе при session_welcome + checkCurrentStreamStatus
    // startLinkRotation() увидит getLinkRotationItems === null и навсегда пропустит ротацию до следующего оффлайна.
    streamMonitor.setLinkRotationProvider(
        async () => {
            const rows = await query<{ response: string; color: string }>(
                'SELECT response, color FROM custom_commands WHERE in_rotation = true AND enabled = true ORDER BY id'
            );
            return rows.map((r) => ({ message: r.response, color: r.color || 'primary' }));
        },
        async () => {
            const row = await queryOne<{ rotation_interval_minutes: number }>(
                'SELECT rotation_interval_minutes FROM links_config WHERE id = 1'
            );
            return row?.rotation_interval_minutes ?? 13;
        }
    );

    setOnLinksConfigUpdatedCallback(() => {
        streamMonitor.reloadLinkRotation();
    });

    streamMonitor.setWelcomeMessageProvider(async () => {
        const row = await queryOne<{ all_links_text: string }>(
            'SELECT all_links_text FROM links_config WHERE id = 1'
        );
        return row?.all_links_text ?? '';
    });

    streamMonitor.setRaidMessageProvider(getRaidMessageFromDb);

    streamMonitor.setRaidDuelBoostHandler((login, viewers) => {
        registerRaidDuelBoostFromRaidEvent(login, viewers);
    });

    if (config.twitch.broadcastAccessToken) {
        streamMonitor.setBroadcastAccessToken(config.twitch.broadcastAccessToken);
    }

    // Retry подключения с exponential backoff (до 5 попыток)
    const MAX_CONNECT_RETRIES = 5;
    const INITIAL_RETRY_DELAY_MS = 2000;
    let connected = false;

    for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
        console.log(`🔌 Попытка подключения к Twitch EventSub (${attempt}/${MAX_CONNECT_RETRIES})...`);
        
        connected = await streamMonitor.connect(
            config.twitch.channel,
            config.twitch.accessToken,
            config.twitch.clientId,
            config.telegram.channelId,
            config.telegram.chatId
        );

        if (connected) {
            console.log(`✅ Подключение к EventSub успешно (попытка ${attempt})`);
            break;
        }

        if (attempt < MAX_CONNECT_RETRIES) {
            const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            console.warn(`⚠️ Подключение не удалось, повтор через ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    if (!connected) {
        console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: Не удалось подключиться к Twitch EventSub после всех попыток');
        console.error('❌ Завершаем процесс для перезапуска через PM2...');
        process.exit(1);
    }

    try {
        if (streamMonitor.getStreamStatus()) {
            await initRaidDuelBoostsFromDb();
        } else {
            await clearAllRaidDuelBoosts();
        }
    } catch (error: any) {
        console.error('⚠️ Рейд-бусты: не удалось синхронизировать с БД:', error?.message || error);
    }

    setOnChatModerationConfigUpdatedCallback(() => {
        nightBotMonitor.invalidateSpamConfigCache();
    });

    // Chat monitor / commands / moderation
    const nightBotMonitor = new NightBotMonitor();

    setOnPartyConfigUpdatedCallback(() => {
        nightBotMonitor.reloadPartyConfigAndCommands();
    });
    await nightBotMonitor.reloadLinksConfigAsync();

    setOnFriendsShoutoutConfigUpdatedCallback(() => {
        nightBotMonitor.reloadFriendsShoutoutConfig();
    });

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
    setGetDuelCooldownSkipCallback(() => nightBotMonitor.getDuelCooldownSkip());
    setSetDuelCooldownSkipCallback((skip: boolean) => nightBotMonitor.setDuelCooldownSkip(skip));
    setGetDuelOverlaySyncEnabledCallback(() => nightBotMonitor.getDuelOverlaySyncEnabled());
    setSetDuelOverlaySyncEnabledCallback((enabled: boolean) => nightBotMonitor.setDuelOverlaySyncEnabled(enabled));
    setGetDuelBannedListCallback(() => nightBotMonitor.getDuelBannedList());
    setPardonDuelUserCallback((username: string) => nightBotMonitor.pardonDuelUser(username));
    const broadcastDuelBanned = getBroadcastDuelBannedChanged();
    if (broadcastDuelBanned) setOnDuelBannedListChanged(broadcastDuelBanned);
    setOnDuelConfigUpdatedCallback((c) => setDuelConfig(c));
    setOnDuelDailyConfigUpdatedCallback((c) => setDailyQuestConfig(c));

    // Загружаем persisted-настройки дуэлей из БД
    await nightBotMonitor.initDuelSettings();

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
        void resetDuelStreamProgressOnStreamEnd();
        clearActiveUsers(config.twitch.channel);
        nightBotMonitor.clearChattersCache();
        nightBotMonitor.clearDetectedModerators();
        nightBotMonitor.disableDuelsFromWeb();
        nightBotMonitor.stopViewersSync();
        void clearAllRaidDuelBoosts();
    });

    // Retry подключения к чату с exponential backoff (до 5 попыток)
    let chatConnected = false;

    for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
        console.log(`💬 Попытка подключения к Twitch чату (${attempt}/${MAX_CONNECT_RETRIES})...`);
        
        chatConnected = await nightBotMonitor.connect(
            config.twitch.channel,
            config.twitch.accessToken,
            config.twitch.clientId,
            config.twitch.broadcastAccessToken
        );

        if (chatConnected) {
            console.log(`✅ Подключение к чату успешно (попытка ${attempt})`);
            break;
        }

        if (attempt < MAX_CONNECT_RETRIES) {
            const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            console.warn(`⚠️ Подключение к чату не удалось, повтор через ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    if (!chatConnected) {
        console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: Не удалось подключиться к Twitch чату после всех попыток');
        console.error('❌ Завершаем процесс для перезапуска через PM2...');
        process.exit(1);
    }

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