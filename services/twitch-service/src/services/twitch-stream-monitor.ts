import {ApiClient} from '@twurple/api';
import {StaticAuthProvider} from '@twurple/auth';
import {EventSubWsListener} from '@twurple/eventsub-ws';
import type {Telegram} from 'telegraf';
import * as fs from 'fs';
import * as path from 'path';
import { ENABLE_BOT_FEATURES } from '../config/features';
import { IS_LOCAL } from '../config/env';
import { addStreamToHistory } from '../storage/stream-history';
import { log } from '../utils/event-logger';

// Определяем корень монорепозитория (как в twitch-players.ts)
const MONOREPO_ROOT = (() => {
  let root = process.cwd();
  if (fs.existsSync(path.join(root, 'package.json'))) {
    return root;
  }
  root = path.resolve(process.cwd(), '../..');
  if (fs.existsSync(path.join(root, 'package.json'))) {
    return root;
  }
  return process.cwd();
})();

// Файл для хранения состояния announcement'ов (в корне монорепы)
const ANNOUNCEMENT_STATE_FILE = path.join(MONOREPO_ROOT, 'announcement-state.json');

interface AnnouncementState {
    lastWelcomeAnnouncementAt: number | null;
    lastLinkAnnouncementAt: number | null;
    currentLinkIndex: number;
    currentStreamPeak: number | null;
    currentStreamStartTime: number | null;
}

/**
 * Загружает состояние announcement'ов из файла
 */
function loadAnnouncementState(): AnnouncementState {
    const defaultState: AnnouncementState = { 
        lastWelcomeAnnouncementAt: null, 
        lastLinkAnnouncementAt: null, 
        currentLinkIndex: 0,
        currentStreamPeak: null,
        currentStreamStartTime: null
    };
    
    try {
        if (fs.existsSync(ANNOUNCEMENT_STATE_FILE)) {
            const data = fs.readFileSync(ANNOUNCEMENT_STATE_FILE, 'utf-8');
            const loadedState = JSON.parse(data);
            
            // Мёржим загруженное состояние с дефолтным (для обратной совместимости)
            return {
                ...defaultState,
                ...loadedState
            };
        }
    } catch (error) {
        console.error('⚠️ Ошибка загрузки состояния announcements:', error);
    }
    
    return defaultState;
}

/**
 * Сохраняет состояние announcement'ов в файл
 */
function saveAnnouncementState(state: AnnouncementState): void {
    try {
        fs.writeFileSync(ANNOUNCEMENT_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (error) {
        console.error('⚠️ Ошибка сохранения состояния announcements:', error);
    }
}

const STREAM_WELCOME_MESSAGE =
    '📸Boosty (запретные фото): https://boosty.to/kunilika911 ───────────────── ' +
    '😻Discord (тут я мурчу): https://discord.gg/zrNsn4vAw2 ───────────────── ' +
    '💖Donation (шанс, что приду): https://donatex.gg/donate/kunilika666 ───────────────── ' +
    '🔮Telegram (тайная жизнь): http://t.me/+rSBrR1FyQqBhZmU1 ───────────────── ' +
    '🎁Fetta (исполни желание): https://fetta.app/u/kunilika666';

const LINK_ANNOUNCEMENTS = [
    {message: '💖Donation (шанс, что приду): https://donatex.gg/donate/kunilika666', color: 'orange' as const},
    {message: '📸Boosty (запретные фото): https://boosty.to/kunilika911', color: 'purple' as const},
    {message: '🔮Telegram (тайная жизнь): http://t.me/+rSBrR1FyQqBhZmU1', color: 'blue' as const},
    {message: '🎁Fetta (исполни желание): https://fetta.app/u/kunilika666', color: 'green' as const}
];

const ANNOUNCEMENT_REPEAT_INTERVAL_MS = 60 * 60 * 1000;
const LINK_ROTATION_INTERVAL_MS = 13 * 60 * 1000;

interface StreamStats {
    startTime: Date;
    viewerCounts: number[];
    broadcasterId: string;
    broadcasterName: string;
    followsCount: number;
}

interface StopTrackingResult {
    stats: {
        peak: number;
        duration: string;
        startTime: Date;
        followsCount: number;
    };
    broadcasterName: string;
}

export class TwitchStreamMonitor {
    private apiClient: ApiClient | null = null;
    private listener: EventSubWsListener | null = null;
    private static sharedListener: EventSubWsListener | null = null;
    private static listenerStarted: boolean = false;
    private static subscriptionsInitialized: boolean = false;
    private static startPromise: Promise<void> | null = null;
    private telegram: Telegram;
    private currentStreamStats: StreamStats | null = null;
    private viewerCountInterval: NodeJS.Timeout | null = null;
    private welcomeInterval: NodeJS.Timeout | null = null;
    private linkRotationInterval: NodeJS.Timeout | null = null;
    private linkRotationTimeout: NodeJS.Timeout | null = null;
    private currentLinkIndex: number = 0;
    private isStreamOnline: boolean = false;
    private announcementState: AnnouncementState;
    private onStreamOfflineCallback: (() => void) | null = null;
    private onStreamOnlineCallback: (() => void) | null = null;

    // Для отправки announcement
    private accessToken: string = '';
    private clientId: string = '';
    private broadcasterId: string = '';
    private moderatorId: string = '';

    // Для отправки обычных сообщений в чат
    private chatSender: ((channel: string, message: string) => Promise<void>) | null = null;
    private channelName: string = '';

    constructor(telegram: Telegram) {
        this.telegram = telegram;
        // Загружаем состояние при создании
        this.announcementState = loadAnnouncementState();
        this.currentLinkIndex = this.announcementState.currentLinkIndex;
        console.log('📋 Загружено состояние announcements:', this.announcementState);
        
        // Закрывает WebSocket транспорт корректно → нет ghost sessions
        // Регистрируем обработчики только один раз (startPromise — самый надёжный lifecycle маркер)
        if (!TwitchStreamMonitor.startPromise) {
            process.once('SIGINT', async () => {
                console.log('🛑 SIGINT — закрываем EventSub');
                if (TwitchStreamMonitor.sharedListener) {
                    try {
                        await TwitchStreamMonitor.sharedListener.stop();
                        TwitchStreamMonitor.sharedListener = null;
                        TwitchStreamMonitor.listenerStarted = false;
                        TwitchStreamMonitor.subscriptionsInitialized = false;
                        TwitchStreamMonitor.startPromise = null;
                        console.log('✅ EventSub listener остановлен (SIGINT)');
                    } catch (error) {
                        console.error('❌ Ошибка остановки listener (SIGINT):', error);
                    }
                }
            });

            process.once('SIGTERM', async () => {
                console.log('🛑 SIGTERM — закрываем EventSub');
                if (TwitchStreamMonitor.sharedListener) {
                    try {
                        await TwitchStreamMonitor.sharedListener.stop();
                        TwitchStreamMonitor.sharedListener = null;
                        TwitchStreamMonitor.listenerStarted = false;
                        TwitchStreamMonitor.subscriptionsInitialized = false;
                        TwitchStreamMonitor.startPromise = null;
                        console.log('✅ EventSub listener остановлен (SIGTERM)');
                    } catch (error) {
                        console.error('❌ Ошибка остановки listener (SIGTERM):', error);
                    }
                }
            });
        }
    }

    /**
     * Устанавливает функцию для отправки сообщений в Twitch чат
     */
    setChatSender(sender: (channel: string, message: string) => Promise<void>, channelName: string): void {
        this.chatSender = sender;
        this.channelName = channelName;
        
        if (this.isStreamOnline) {
            console.log('📣 Chat sender установлен, проверяем нужно ли отправить welcome сообщение...');
            this.sendWelcomeMessage(false).catch(err => {
                console.error('❌ Ошибка отправки отложенного welcome:', err);
            });
        }
    }

    /**
     * Подключение к Twitch EventSub для мониторинга стримов
     * @param channelName - имя канала (без #)
     * @param accessToken - OAuth токен для Twitch
     * @param clientId - Client ID приложения Twitch
     * @param telegramChannelId - ID Telegram канала для уведомлений
     * @returns Promise<boolean> - true при успешном подключении, false при ошибке
     */
    async connect(
        channelName: string,
        accessToken: string,
        clientId: string,
        telegramChannelId?: string
    ): Promise<boolean> {
        // если singleton listener уже существует, реюзим его
        // НЕ делаем early return — нужно инициализировать apiClient, broadcasterId и т.д.
        if (TwitchStreamMonitor.sharedListener) {
            this.listener = TwitchStreamMonitor.sharedListener;
            console.log('♻️ Singleton listener уже существует, реюзим');
        }

        try {
            this.accessToken = accessToken;
            this.clientId = clientId;

            const authProvider = new StaticAuthProvider(clientId, accessToken);

            this.apiClient = new ApiClient({authProvider});

            const user = await this.apiClient.users.getUserByName(channelName);

            if (!user) {
                throw new Error(`Пользователь ${channelName} не найден`);
            }

            this.broadcasterId = user.id;
            console.error(`✅ Найден канал: ${user.displayName}`);

            const validateRes = await fetch('https://id.twitch.tv/oauth2/validate', {
                headers: {'Authorization': `OAuth ${accessToken}`}
            });

            if (validateRes.ok) {
                const validateData = await validateRes.json() as { user_id: string };
                this.moderatorId = validateData.user_id;
            }

            // используем singleton listener
            // Twurple WS listener САМ управляет lifecycle подписок
            // Ручной cleanup через API создаёт проблемы — WebSocket транспорты остаются висеть
            // Один listener = один WebSocket транспорт НАВСЕГДА
            if (!TwitchStreamMonitor.sharedListener) {
                TwitchStreamMonitor.sharedListener = new EventSubWsListener({
                    apiClient: this.apiClient
                });
                console.log('🆕 EventSubWsListener создан (singleton)');
            }
            
            this.listener = TwitchStreamMonitor.sharedListener;

            // стартуем listener только ОДИН раз за жизнь процесса
            // Promise lock защищает от race condition при параллельном connect()
            if (!TwitchStreamMonitor.listenerStarted) {
                if (!TwitchStreamMonitor.startPromise) {
                    TwitchStreamMonitor.startPromise = (async () => {
                        await this.listener!.start();
                        TwitchStreamMonitor.listenerStarted = true;
                        console.log('✅ EventSub WebSocket подключен');
                    })();
                }
                
                // Ждём завершения Promise (даже если создан другим параллельным connect())
                await TwitchStreamMonitor.startPromise;
            } else {
                console.log('♻️ EventSub listener уже запущен, реюзим singleton');
            }

            // регистрируем подписки только ОДИН раз за жизнь процесса
            // Флаг static — иначе при new TwitchStreamMonitor() добавятся повторно
            if (!TwitchStreamMonitor.subscriptionsInitialized) {
                // Подписываемся на событие начала стрима
                this.listener.onStreamOnline(user.id, async (event) => {
                // Вызываем коллбек для запуска синхронизации зрителей (до проверки на дубли)
                // Это гарантирует, что синхронизация запустится даже при повторном событии
                try {
                    this.onStreamOnlineCallback?.();
                    console.log('✅ Синхронизация зрителей запущена при начале стрима');
                } catch (e) {
                    console.error('❌ Ошибка при запуске синхронизации зрителей:', e);
                }

                // Защита от дублей (если уже обработали через checkCurrentStreamStatus)
                if (this.isStreamOnline) {
                    console.error(`⚠️ Стрим уже онлайн, пропускаем дубль события (синхронизация перезапущена)`);
                    return;
                }

                console.error(`🔴 Стрим начался на канале ${event.broadcasterDisplayName}!`);
                this.isStreamOnline = true;

                // Сбрасываем статистику текущего стрима (новый стрим начался)
                this.announcementState.currentStreamPeak = null;
                this.announcementState.currentStreamStartTime = Date.now();
                saveAnnouncementState(this.announcementState);
                console.log('🔄 Статистика текущего стрима сброшена (новый стрим)');

                // Получаем реальное время начала стрима из API
                const stream = await this.apiClient!.streams.getStreamByUserId(event.broadcasterId);
                const startDate = stream?.startDate || new Date();

                // Логируем начало стрима (только факт, детали есть в stream-history)
                log('STREAM_ONLINE', {
                    channel: event.broadcasterDisplayName
                });

                // Отправляем приветственное сообщение (все ссылки)
                await this.sendWelcomeMessage();

                // Запускаем повтор welcome сообщения каждый час
                this.startWelcomeMessageInterval();

                // Запускаем ротацию отдельных ссылок через 13 минут (force=true для нового стрима)
                this.startLinkRotation(true);

                await this.handleStreamOnline(event, telegramChannelId);

                this.startViewerCountTracking(event.broadcasterId, event.broadcasterName, startDate);
            });

            // Подписываемся на событие завершения стрима
            this.listener.onStreamOffline(user.id, async (event) => {
                console.error(`⚫ Стрим завершился на канале ${event.broadcasterDisplayName}`);
                this.isStreamOnline = false;

                try {
                    this.onStreamOfflineCallback?.();
                    console.log('🧹 Очередь дуэлей очищена (стрим оффлайн)');
                } catch (e) {
                    console.error('❌ Ошибка при очистке очереди дуэлей:', e);
                }

                // Останавливаем все интервалы
                this.stopWelcomeMessageInterval();
                this.stopLinkRotation();

                const result = this.stopViewerCountTracking();
                
                // Логируем завершение стрима (только факт, детали есть в stream-history)
                log('STREAM_OFFLINE', {
                    channel: event.broadcasterDisplayName
                });
                
                await this.handleStreamOffline(event, telegramChannelId, result);
            });

            // Подписываемся на событие Follow (когда пользователь нажимает "Отслеживать")
            this.listener.onChannelFollow(user.id, this.moderatorId, async (event) => {
                console.log(`💜 Новый фоловер: ${event.userDisplayName} (@${event.userName})`);
                
                // Увеличиваем счётчик follow только если стрим онлайн
                if (this.isStreamOnline && this.currentStreamStats) {
                    this.currentStreamStats.followsCount++;
                    console.log(`📊 Follow за стрим: ${this.currentStreamStats.followsCount}`);
                } else if (!this.isStreamOnline) {
                    console.log(`ℹ️ Follow получен вне стрима, не учитывается в статистике`);
                }
                
                
                // Проверяем, включены ли функции бота
                if (!ENABLE_BOT_FEATURES) {
                    console.log('🔇 Благодарности за Follow отключены (ENABLE_BOT_FEATURES=false)');
                    return;
                }
                
                // Локально блокируем отправку (защита от дублирования с сервером)
                // Импортируем ALLOW_LOCAL_COMMANDS из config/features
                const { ALLOW_LOCAL_COMMANDS } = require('../config/features');
                if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) {
                    console.log('🔒 Локально благодарности за Follow заблокированы (для теста добавь ALLOW_LOCAL_COMMANDS=true в .env.local)');
                    return;
                }

                // Отправляем благодарность в чат
                if (this.chatSender && this.channelName) {
                    try {
                        await this.chatSender(this.channelName, `${event.userDisplayName} спасибо за follow❤️`);
                        console.log(`✅ Отправлена благодарность за Follow: ${event.userDisplayName}`);
                    } catch (error) {
                        console.error('❌ Ошибка отправки благодарности за Follow:', error);
                    }
                } else {
                    console.error('⚠️ Chat sender не установлен для отправки благодарности за Follow');
                }
            });

                TwitchStreamMonitor.subscriptionsInitialized = true;
                console.log('📋 Подписки EventSub зарегистрированы:');
                console.log('   • stream.online');
                console.log('   • stream.offline');
                console.log('   • channel.follow');
            } else {
                console.log('♻️ Подписки уже зарегистрированы, пропускаем');
            }
            
            console.error(`✅ Мониторинг стримов запущен для канала: ${channelName}`);
            log('CONNECTION', {
                service: 'TwitchStreamMonitor',
                status: 'connected',
                channel: channelName
            });

            await this.checkCurrentStreamStatus(user.id);

            return true;
        } catch (error: any) {
            console.error('❌ Ошибка подключения к Twitch EventSub:', error);
            log('ERROR', {
                context: 'TwitchStreamMonitor.connect',
                error: error?.message || String(error),
                stack: error?.stack,
                channel: channelName
            });
            return false;
        }
    }

    /**
     * Проверка текущего статуса стрима
     */
    private async checkCurrentStreamStatus(userId: string) {
        if (!this.apiClient) return;

        try {
            const stream = await this.apiClient.streams.getStreamByUserId(userId);

            if (stream) {
                console.error(`📊 Статус стрима: 🟢 В ЭФИРЕ`);
                console.error(`   🎮 Игра: ${stream.gameName || 'Не указана'}`);
                console.error(`   📝 Название: ${stream.title}`);
                console.error(`   👥 Зрителей: ${stream.viewers}`);

                // Устанавливаем флаг, что стрим онлайн
                this.isStreamOnline = true;

                // Вызываем коллбек для запуска синхронизации зрителей (если стрим уже онлайн)
                try {
                    this.onStreamOnlineCallback?.();
                    console.log('✅ Синхронизация зрителей запущена (стрим уже онлайн)');
                } catch (e) {
                    console.error('❌ Ошибка при запуске синхронизации зрителей:', e);
                }

                // sendWelcomeMessage проверит время последней отправки
                console.error(`📣 Проверяем нужно ли отправить welcome сообщение...`);
                await this.sendWelcomeMessage(false);

                // Запускаем повтор welcome сообщения (учитывает время последней отправки)
                this.startWelcomeMessageInterval();

                // Запускаем ротацию ссылок
                this.startLinkRotation();

                // Получаем информацию о broadcasterе для запуска отслеживания
                const user = await this.apiClient.users.getUserById(userId);
                if (user) {
                    // Запускаем отслеживание зрителей, так как стрим уже идёт
                    console.error(`🔄 Запускаем отслеживание зрителей...`);
                    this.startViewerCountTracking(userId, user.name, stream.startDate);
                }
            } else {
                console.error(`📊 Статус стрима: 🔴 Оффлайн`);
            }
        } catch (error) {
            console.error('⚠️ Не удалось получить статус стрима');
        }
    }

    /**
     * Обработчик события начала стрима
     */
    private async handleStreamOnline(event: any, telegramChannelId?: string) {
        if (!telegramChannelId || !this.apiClient) {
            console.error('⚠️ CHANNEL_ID не установлен, уведомление не отправлено');
            return;
        }

        try {
            // Пытаемся получить информацию о стриме с повторными попытками
            let stream = await this.apiClient.streams.getStreamByUserId(event.broadcasterId);

            // Если не получилось с первого раза, делаем повторную попытку через 2 секунды
            if (!stream) {
                console.error('⚠️ Не удалось получить информацию о стриме с первой попытки, повторная попытка через 2 сек...');
                await new Promise(resolve => setTimeout(resolve, 2000));
                stream = await this.apiClient.streams.getStreamByUserId(event.broadcasterId);
            }

            // Формируем сообщение в зависимости от наличия данных
            let message: string;

            if (stream) {
                message = `
🟢 <b>Стрим начался!</b>

<b>Канал:</b> ${event.broadcasterDisplayName}
<b>Категория:</b> ${stream.gameName || 'Не указана'}
<b>Название:</b> ${stream.title}

   <a href="https://twitch.tv/${event.broadcasterName}">${event.broadcasterDisplayName}</a>
      `.trim();
            } else {
                // Если всё равно не получилось получить данные - отправляем базовое уведомление
                console.error('⚠️ API не вернул данные о стриме, отправляем базовое уведомление');
                message = `
🟢 <b>Стрим начался!</b>

<b>Канал:</b> ${event.broadcasterDisplayName}

   <a href="https://twitch.tv/${event.broadcasterName}">${event.broadcasterDisplayName}</a>
      `.trim();
            }

            await this.telegram.sendMessage(telegramChannelId, message, {
                parse_mode: 'HTML',
                link_preview_options: {is_disabled: false}
            });

            console.error('✅ Уведомление о начале стрима отправлено в Telegram');
        } catch (error: any) {
            console.error('❌ Ошибка при отправке уведомления:', error);
            log('ERROR', {
                context: 'handleStreamOnline',
                error: error?.message || String(error),
                stack: error?.stack,
                channel: event.broadcasterDisplayName
            });

            // Даже при ошибке пытаемся отправить минимальное уведомление
            try {
                const fallbackMessage = `🟢 <b>Стрим начался на канале ${event.broadcasterDisplayName}!</b>\n\n🔗 <a href="https://twitch.tv/${event.broadcasterName}">${event.broadcasterDisplayName}</a>`;
                await this.telegram.sendMessage(telegramChannelId, fallbackMessage, {
                    parse_mode: 'HTML',
                    link_preview_options: {is_disabled: false}
                });
                console.error('✅ Резервное уведомление отправлено');
            } catch (fallbackError: any) {
                console.error('❌ Даже резервное уведомление не удалось отправить:', fallbackError);
                log('ERROR', {
                    context: 'handleStreamOnline.fallback',
                    error: fallbackError?.message || String(fallbackError),
                    stack: fallbackError?.stack,
                    channel: event.broadcasterDisplayName
                });
            }
        }
    }

    /**
     * Запуск отслеживания количества зрителей
     */
    private startViewerCountTracking(broadcasterId: string, broadcasterName: string, startDate: Date) {
        // Защита от двойного запуска
        if (this.viewerCountInterval || this.currentStreamStats) {
            console.error('⚠️ Отслеживание зрителей уже запущено, пропускаем');
            return;
        }

        // Инициализируем статистику с реальным временем начала стрима
        const initialCounts: number[] = [];
        
        // Восстанавливаем сохранённый пик (если бот перезапустился во время стрима)
        if (this.announcementState.currentStreamPeak !== null) {
            initialCounts.push(this.announcementState.currentStreamPeak);
            console.error(`🔄 Восстановлен пик зрителей из файла: ${this.announcementState.currentStreamPeak}`);
        }
        
        this.currentStreamStats = {
            startTime: startDate,
            viewerCounts: initialCounts,
            broadcasterId,
            broadcasterName,
            followsCount: 0
        };

        console.error('📊 Запущено отслеживание количества зрителей');
        console.error(`⏱️  Время начала стрима: ${startDate.toLocaleString('ru-RU')}`);
        console.error(`💡 Используется синхронизированный опрос:`);
        console.error(`   - Каждую минуту: chatters API запрашивается фоново`);
        console.error(`   - При каждом запросе chatters: синхронно запрашивается viewers API`);
        console.error(`   - В статистику записывается: max(chatters, viewers)`);
        
        // Примечание: регулярный опрос viewers больше не нужен, так как он происходит
        // при каждом опросе chatters (каждую минуту) через синхронизацию
    }

    public setOnStreamOfflineCallback(cb: () => void) {
        this.onStreamOfflineCallback = cb;
    }

    public setOnStreamOnlineCallback(cb: () => void) {
        this.onStreamOnlineCallback = cb;
    }

    /**
     * Остановка отслеживания количества зрителей
     * @returns статистика стрима или null
     */
    private stopViewerCountTracking(): StopTrackingResult | null {
        if (this.viewerCountInterval) {
            clearInterval(this.viewerCountInterval);
            this.viewerCountInterval = null;
        }

        if (!this.currentStreamStats || this.currentStreamStats.viewerCounts.length === 0) {
            this.currentStreamStats = null;
            return null;
        }

        const stats = this.calculateStreamStats();
        const broadcasterName = this.currentStreamStats.broadcasterName;
        const startTime = this.currentStreamStats.startTime;

        // Выводим статистику в консоль
        console.error('\n📊 ===== СТАТИСТИКА СТРИМА =====');
        console.error(`👤 Канал: ${broadcasterName}`);
        console.error(`⏱️  Длительность: ${stats.duration}`);
        console.error(`👥 Пик зрителей: ${stats.peak}`);
        console.error(`💜 Новых follow: ${stats.followsCount}`);
        console.error('================================\n');

        // Очищаем данные
        this.currentStreamStats = null;

        return {
            stats: {
                ...stats,
                startTime
            },
            broadcasterName
        };
    }

    /**
     * Получение и запись текущего количества зрителей
     */
    private async fetchAndRecordViewerCount() {
        if (!this.apiClient || !this.currentStreamStats) return;

        try {
            const stream = await this.apiClient.streams.getStreamByUserId(this.currentStreamStats.broadcasterId);

            if (stream) {
                const viewerCount = stream.viewers;
                this.currentStreamStats.viewerCounts.push(viewerCount);
                console.error(`📊 Зрителей сейчас: ${viewerCount}`);
            }
        } catch (error) {
            console.error('⚠️ Ошибка при получении количества зрителей:', error);
        }
    }

    /**
     * Подсчет статистики стрима
     */
    private calculateStreamStats() {
        if (!this.currentStreamStats || this.currentStreamStats.viewerCounts.length === 0) {
            return {peak: 0, duration: '0мин', followsCount: 0};
        }

        const counts = this.currentStreamStats.viewerCounts.filter(c => typeof c === 'number' && !isNaN(c));
        const peak = counts.length > 0 ? Math.max(...counts) : 0;

        // Подсчет длительности
        const durationMs = Date.now() - this.currentStreamStats.startTime.getTime();
        const hours = Math.floor(durationMs / 3600000);
        const minutes = Math.floor((durationMs % 3600000) / 60000);
        const duration = hours > 0 ? `${hours}ч ${minutes}мин` : `${minutes}мин`;

        return {peak, duration, followsCount: this.currentStreamStats.followsCount};
    }

    /**
     * Обработчик события завершения стрима
     */
    private async handleStreamOffline(event: any, telegramChannelId?: string, result?: StopTrackingResult | null) {
        console.error(`⚫ Стрим завершён: ${event.broadcasterDisplayName}`);
        console.log(`[DEBUG] telegramChannelId = ${telegramChannelId}, result = ${result ? 'exists' : 'null'}`);

        // Отправляем уведомление о завершении (со статистикой если есть)
        if (telegramChannelId) {
            try {
                let message: string;

                if (result) {
                    const {stats} = result;
                    message = [
                        `🔴 Стрим <a href="https://twitch.tv/${event.broadcasterName}">${event.broadcasterDisplayName}</a> закончился`,
                        ``,
                        `   <b>Максимум зрителей:</b> ${stats.peak}`,
                        `   <b>Продолжительность:</b> ${stats.duration}`
                    ].join('\n');
                } else {
                    message = `🔴 Стрим <a href="https://twitch.tv/${event.broadcasterName}">${event.broadcasterDisplayName}</a> закончился`;
                }

                await this.telegram.sendMessage(telegramChannelId, message, {
                    parse_mode: 'HTML',
                    link_preview_options: {is_disabled: true}
                });

                console.error('✅ Уведомление об окончании стрима отправлено в Telegram');
            } catch (error: any) {
                console.error('❌ Ошибка при отправке уведомления об окончании:', error);
                log('ERROR', {
                    context: 'handleStreamOffline',
                    error: error?.message || String(error),
                    stack: error?.stack,
                    channel: event.broadcasterDisplayName
                });
            }
        } else {
            console.error('⚠️ CHANNEL_ID не установлен, уведомление о завершении не отправлено');
        }

        // Сохраняем статистику стрима в историю
        if (result) {
            try {
                const {stats} = result;
                
                // Конвертируем дату и время в МСК (UTC+3)
                const mskTime = new Date(stats.startTime.getTime() + 3 * 60 * 60 * 1000);
                const dateStr = mskTime.toISOString().split('T')[0]; // YYYY-MM-DD
                const timeStr = mskTime.toISOString().split('T')[1].substring(0, 5) + ' МСК'; // HH:MM МСК
                
                addStreamToHistory({
                    date: dateStr,
                    startTime: timeStr,
                    duration: stats.duration,
                    peakViewers: stats.peak,
                    followsCount: stats.followsCount
                });
                
                // Сбрасываем статистику текущего стрима после сохранения в историю
                this.announcementState.currentStreamPeak = null;
                this.announcementState.currentStreamStartTime = null;
                saveAnnouncementState(this.announcementState);
                console.log('🔄 Статистика текущего стрима сброшена (стрим завершён)');
            } catch (error: any) {
                console.error('❌ Ошибка при сохранении истории стрима:', error);
                log('ERROR', {
                    context: 'handleStreamOffline.saveHistory',
                    error: error?.message || String(error),
                    stack: error?.stack
                });
            }
        }
    }

    /**
     * Отправляет приветственное сообщение (обычный текст) в чат
     * @param force - если true, отправляет независимо от времени последней отправки
     */
    private async sendWelcomeMessage(force: boolean = false): Promise<void> {
        // Проверяем, что стрим онлайн (защита от отправки оффлайн)
        if (!this.isStreamOnline) {
            console.log('⚠️ Стрим оффлайн, пропускаем welcome сообщение');
            return;
        }
        
        if (!ENABLE_BOT_FEATURES) {
            console.log('🔇 Welcome сообщения отключены (ENABLE_BOT_FEATURES=false)');
            return;
        }
        
        // Локально блокируем отправку (защита от дублирования с сервером)
        const { ALLOW_LOCAL_COMMANDS } = require('../config/features');
        if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) {
            console.log('🔒 Локально welcome сообщения заблокированы (для теста добавь ALLOW_LOCAL_COMMANDS=true в .env.local)');
            return;
        }

        if (!this.chatSender || !this.channelName) {
            console.error('⚠️ Chat sender не установлен, пропускаем приветственное сообщение');
            return;
        }

        // Проверяем, прошло ли достаточно времени с последней отправки
        const now = Date.now();
        const lastSent = this.announcementState.lastWelcomeAnnouncementAt;
        const timeSinceLastSent = lastSent ? now - lastSent : Infinity;
        const minInterval = ANNOUNCEMENT_REPEAT_INTERVAL_MS * 0.9; // 90% от интервала (защита от погрешности)

        if (!force && lastSent && timeSinceLastSent < minInterval) {
            const remainingMins = Math.ceil((minInterval - timeSinceLastSent) / 60000);
            console.log(`⏳ Welcome сообщение пропущено: прошло ${Math.floor(timeSinceLastSent / 60000)} мин, осталось ~${remainingMins} мин`);
            return;
        }

        try {
            console.log('📣 Отправка приветственного сообщения в чат...');

            // Отправляем обычное текстовое сообщение в чат
            await this.chatSender(this.channelName, STREAM_WELCOME_MESSAGE);

            // Сохраняем время отправки
            this.announcementState.lastWelcomeAnnouncementAt = now;
            saveAnnouncementState(this.announcementState);

            console.log('✅ Приветственное сообщение отправлено в чат!');

        } catch (error: any) {
            console.error('❌ Ошибка при отправке приветственного сообщения:', error.message || error);
        }
    }

    /**
     * Запускает повтор welcome сообщения каждые N минут
     * Учитывает время последней отправки для синхронизации
     */
    private startWelcomeMessageInterval(): void {
        // Останавливаем предыдущий интервал, если был
        this.stopWelcomeMessageInterval();

        const mins = ANNOUNCEMENT_REPEAT_INTERVAL_MS / 60000;
        const hours = mins / 60;
        
        // Вычисляем когда следующая отправка
        const now = Date.now();
        const lastSent = this.announcementState.lastWelcomeAnnouncementAt;
        let initialDelay = ANNOUNCEMENT_REPEAT_INTERVAL_MS;

        if (lastSent) {
            const timeSinceLastSent = now - lastSent;
            const remaining = ANNOUNCEMENT_REPEAT_INTERVAL_MS - timeSinceLastSent;
            
            if (remaining > 0) {
                initialDelay = remaining;
                console.log(`🔁 Welcome сообщение: последняя отправка ${Math.floor(timeSinceLastSent / 60000)} мин назад, следующая через ${Math.ceil(remaining / 60000)} мин`);
            } else {
                initialDelay = 5000;
                console.log(`🔁 Welcome сообщение: время прошло (${Math.floor(timeSinceLastSent / 60000)} мин назад), отправка через 5 сек`);
            }
        } else {
            console.log(`🔁 Welcome сообщение каждые ${mins} мин (${hours}ч)`);
        }

        const runMessage = async () => {
            console.log('🔄 Повтор welcome сообщения...');
            await this.sendWelcomeMessage(true);
        };

        setTimeout(async () => {
            await runMessage();
            this.welcomeInterval = setInterval(runMessage, ANNOUNCEMENT_REPEAT_INTERVAL_MS);
        }, initialDelay);
    }

    /**
     * Останавливает повтор welcome сообщения
     */
    private stopWelcomeMessageInterval(): void {
        if (this.welcomeInterval) {
            clearInterval(this.welcomeInterval);
            this.welcomeInterval = null;
            console.log('⏹️ Повтор welcome сообщения остановлен');
        }
    }

    /**
     * Запускает ротацию ссылок (через 13 минут после начала, затем каждые 13 минут)
     * При запуске стрима используется force=true для полного сброса
     * @param force - если true, игнорирует lastLinkAnnouncementAt и запускает с полной задержкой
     */
    private startLinkRotation(force: boolean = false): void {
        this.stopLinkRotation();

        const mins = LINK_ROTATION_INTERVAL_MS / 60000;
        let initialDelay = LINK_ROTATION_INTERVAL_MS;

        // Если force=true (старт стрима), всегда используем полный интервал
        if (force) {
            initialDelay = LINK_ROTATION_INTERVAL_MS;
            console.log(`🔄 Ротация ссылок: старт стрима, первая через ${mins} мин, затем каждые ${mins} мин`);
        } else {
            // При переподключении бота во время стрима - тоже используем полный интервал
            // Это предотвращает спам ссылками
            console.log(`🔄 Ротация ссылок: переподключение, следующая через ${mins} мин`);
        }

        this.linkRotationTimeout = setTimeout(() => {
            this.sendNextLinkAnnouncement();

            this.linkRotationInterval = setInterval(() => {
                this.sendNextLinkAnnouncement();
            }, LINK_ROTATION_INTERVAL_MS);
        }, initialDelay);
    }

    /**
     * Останавливает ротацию ссылок
     */
    private stopLinkRotation(): void {
        const hadTimeout = !!this.linkRotationTimeout;
        const hadInterval = !!this.linkRotationInterval;

        // Очищаем timeout (первая отправка через 13 минут)
        if (this.linkRotationTimeout) {
            clearTimeout(this.linkRotationTimeout);
            this.linkRotationTimeout = null;
        }

        // Очищаем interval (повторы каждые 13 минут)
        if (this.linkRotationInterval) {
            clearInterval(this.linkRotationInterval);
            this.linkRotationInterval = null;
        }

        // Сбрасываем индекс, если что-то было активно
        if (hadTimeout || hadInterval) {
            this.currentLinkIndex = 0;
            
            // Сохраняем сброшенный индекс в файл
            this.announcementState.currentLinkIndex = 0;
            saveAnnouncementState(this.announcementState);
            
            console.log('⏹️ Ротация ссылок остановлена и сброшена в файл');
        }
    }

    /**
     * Отправляет следующий announcement из ротации ссылок
     */
    private async sendNextLinkAnnouncement(): Promise<void> {
        // Проверяем, что стрим онлайн (защита от отправки оффлайн)
        if (!this.isStreamOnline) {
            console.log('⚠️ Стрим оффлайн, пропускаем ротацию ссылок');
            return;
        }
        
        if (!ENABLE_BOT_FEATURES) {
            console.log('🔇 Ротация ссылок отключена (ENABLE_BOT_FEATURES=false)');
            return;
        }
        
        // Локально блокируем отправку (защита от дублирования с сервером)
        const { ALLOW_LOCAL_COMMANDS } = require('../config/features');
        if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) {
            console.log('🔒 Локально ротация ссылок заблокирована (для теста добавь ALLOW_LOCAL_COMMANDS=true в .env.local)');
            return;
        }

        if (!this.accessToken || !this.clientId || !this.broadcasterId || !this.moderatorId) {
            console.error('⚠️ Нет данных для отправки link announcement');
            return;
        }

        const currentLink = LINK_ANNOUNCEMENTS[this.currentLinkIndex];

        try {
            console.log(`📣 Ротация ссылок [${this.currentLinkIndex + 1}/${LINK_ANNOUNCEMENTS.length}]: ${currentLink.message.split(':')[0]}`);

            const announcementRes = await fetch(
                `https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${this.broadcasterId}&moderator_id=${this.moderatorId}`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Client-Id': this.clientId,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: currentLink.message,
                        color: currentLink.color
                    })
                }
            );

            if (!announcementRes.ok) {
                const errorText = await announcementRes.text();
                throw new Error(`Ошибка отправки link announcement: ${announcementRes.status} ${errorText}`);
            }

            console.log(`✅ Link announcement отправлен (цвет: ${currentLink.color})`);

            // Переходим к следующей ссылке
            this.currentLinkIndex = (this.currentLinkIndex + 1) % LINK_ANNOUNCEMENTS.length;

            // Сохраняем состояние
            this.announcementState.lastLinkAnnouncementAt = Date.now();
            this.announcementState.currentLinkIndex = this.currentLinkIndex;
            saveAnnouncementState(this.announcementState);

        } catch (error: any) {
            console.error('❌ Ошибка при отправке link announcement:', error.message || error);
        }
    }

    /**
     * Отключение от EventSub (graceful shutdown)
     * ВНИМАНИЕ: это закроет singleton listener для ВСЕГО процесса
     */
    async disconnect(): Promise<void> {
        try {
            this.isStreamOnline = false;
            this.stopViewerCountTracking();
            this.stopWelcomeMessageInterval();
            this.stopLinkRotation();

            // Останавливаем singleton listener (один раз на весь процесс)
            if (TwitchStreamMonitor.sharedListener) {
                await TwitchStreamMonitor.sharedListener.stop();
                TwitchStreamMonitor.sharedListener = null;
                TwitchStreamMonitor.listenerStarted = false;
                TwitchStreamMonitor.subscriptionsInitialized = false;
                TwitchStreamMonitor.startPromise = null;
                console.error('🛑 Отключено от Twitch EventSub (singleton)');
                log('CONNECTION', {
                    service: 'TwitchStreamMonitor',
                    status: 'disconnected'
                });
            }
        } catch (error: any) {
            console.error('❌ Ошибка при отключении от Twitch EventSub:', error);
            log('ERROR', {
                context: 'TwitchStreamMonitor.disconnect',
                error: error?.message || String(error),
                stack: error?.stack
            });
        }
    }

    /**
     * Проверка, онлайн ли сейчас стрим
     */
    public getStreamStatus(): boolean {
        return this.isStreamOnline;
    }

    /**
     * Немедленно запрашивает и записывает текущее количество зрителей
     * Используется для синхронизации с запросом chatters (более точный пик)
     * Сравнивает viewers API и chatters, записывает максимальное значение
     */
    public async recordViewersNow(chattersCount?: number): Promise<void> {
        if (!this.isStreamOnline || !this.apiClient || !this.currentStreamStats) {
            return;
        }

        try {
            const stream = await this.apiClient.streams.getStreamByUserId(this.currentStreamStats.broadcasterId);
            
            if (stream) {
                const viewersAPI = stream.viewers;
                
                // Берём максимальное значение из двух источников
                // Viewers API может отставать, chatters обновляется быстрее
                const actualViewers = chattersCount 
                    ? Math.max(viewersAPI, chattersCount)
                    : viewersAPI;
                
                this.currentStreamStats.viewerCounts.push(actualViewers);
                
                // Обновляем сохранённый пик, если новое значение больше
                if (this.announcementState.currentStreamPeak === null || actualViewers > this.announcementState.currentStreamPeak) {
                    this.announcementState.currentStreamPeak = actualViewers;
                    saveAnnouncementState(this.announcementState);
                }
                
                if (chattersCount) {
                    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                    console.log('📊 СИНХРОНИЗАЦИЯ ДВУХ API:');
                    console.log(`Viewers API (streams):  ${viewersAPI}`);
                    console.log(`Chatters API (chat):    ${chattersCount}`);
                    console.log(`Записываем в статистику: ${actualViewers} (максимум)`);
                    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                } else {
                    console.log(`📊 Регулярный замер viewers API: ${actualViewers}`);
                }
            }
        } catch (error) {
            console.error('⚠️ Ошибка синхронизированного замера viewers:', error);
        }
    }
}
