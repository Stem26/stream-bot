import {ApiClient} from '@twurple/api';
import {StaticAuthProvider} from '@twurple/auth';
import {EventSubWsListener} from '@twurple/eventsub-ws';
import type {Telegram} from 'telegraf';
import * as fs from 'fs';
import * as path from 'path';
import { ENABLE_BOT_FEATURES } from '../config/features';

// Файл для хранения состояния announcement'ов (в корне монорепы)
const ANNOUNCEMENT_STATE_FILE = path.resolve(__dirname, '../../../../../announcement-state.json');

interface AnnouncementState {
    lastWelcomeAnnouncementAt: number | null;  // timestamp
    lastLinkAnnouncementAt: number | null;     // timestamp
    currentLinkIndex: number;
}

/**
 * Загружает состояние announcement'ов из файла
 */
function loadAnnouncementState(): AnnouncementState {
    try {
        if (fs.existsSync(ANNOUNCEMENT_STATE_FILE)) {
            const data = fs.readFileSync(ANNOUNCEMENT_STATE_FILE, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('⚠️ Ошибка загрузки состояния announcements:', error);
    }
    return { lastWelcomeAnnouncementAt: null, lastLinkAnnouncementAt: null, currentLinkIndex: 0 };
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
    '🔮Telegram (тайная жизнь): https://t.me/+V96KfRWs17AxNzM9';

const LINK_ANNOUNCEMENTS = [
    {message: '💖Donation (шанс, что приду): https://donatex.gg/donate/kunilika666', color: 'orange' as const},
    {message: '📸Boosty (запретные фото): https://boosty.to/kunilika911', color: 'purple' as const},
    {message: '🔮Telegram (тайная жизнь): https://t.me/+V96KfRWs17AxNzM9', color: 'blue' as const}
];

const ANNOUNCEMENT_REPEAT_INTERVAL_MS = 60 * 60 * 1000;
const LINK_ROTATION_INTERVAL_MS = 15 * 60 * 1000;

interface StreamStats {
    startTime: Date;
    viewerCounts: number[];
    broadcasterId: string;
    broadcasterName: string;
}

interface StopTrackingResult {
    stats: {
        peak: number;
        duration: string;
    };
    broadcasterName: string;
}

export class TwitchStreamMonitor {
    private apiClient: ApiClient | null = null;
    private listener: EventSubWsListener | null = null;
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
    }

    /**
     * Устанавливает функцию для отправки сообщений в Twitch чат
     */
    setChatSender(sender: (channel: string, message: string) => Promise<void>, channelName: string): void {
        this.chatSender = sender;
        this.channelName = channelName;
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
        if (this.listener) {
            console.error('⚠️ TwitchStreamMonitor уже подключён');
            return true;
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

            this.listener = new EventSubWsListener({apiClient: this.apiClient});

            await this.listener.start();

            // Подписываемся на событие начала стрима
            this.listener.onStreamOnline(user.id, async (event) => {
                // Защита от дублей (если уже обработали через checkCurrentStreamStatus)
                if (this.isStreamOnline) {
                    console.error(`⚠️ Стрим уже онлайн, пропускаем дубль события`);
                    return;
                }

                console.error(`🔴 Стрим начался на канале ${event.broadcasterDisplayName}!`);
                this.isStreamOnline = true;

                // Отправляем приветственное сообщение (все ссылки)
                await this.sendWelcomeMessage();

                // Запускаем повтор welcome сообщения каждый час
                this.startWelcomeMessageInterval();

                // Запускаем ротацию отдельных ссылок через 15 минут
                this.startLinkRotation();

                await this.handleStreamOnline(event, telegramChannelId);

                // Получаем реальное время начала стрима из API
                const stream = await this.apiClient!.streams.getStreamByUserId(event.broadcasterId);
                const startDate = stream?.startDate || new Date();

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
                await this.handleStreamOffline(event, telegramChannelId, result);
            });

            // Подписываемся на событие Follow (когда пользователь нажимает "Отслеживать")
            this.listener.onChannelFollow(user.id, this.moderatorId, async (event) => {
                console.log(`💜 Новый фоловер: ${event.userDisplayName} (@${event.userName})`);
                
                // Проверяем, включены ли функции бота
                if (!ENABLE_BOT_FEATURES) {
                    console.log('⚠️ Благодарности за Follow отключены (ENABLE_BOT_FEATURES=false)');
                    return;
                }

                // Отправляем благодарность в чат
                if (this.chatSender && this.channelName) {
                    try {
                        await this.chatSender(this.channelName, `${event.userDisplayName} спасибо за подписку ❤️`);
                        console.log(`✅ Отправлена благодарность за Follow: ${event.userDisplayName}`);
                    } catch (error) {
                        console.error('❌ Ошибка отправки благодарности за Follow:', error);
                    }
                } else {
                    console.error('⚠️ Chat sender не установлен для отправки благодарности за Follow');
                }
            });

            console.error(`✅ Мониторинг стримов запущен для канала: ${channelName}`);

            await this.checkCurrentStreamStatus(user.id);

            return true;
        } catch (error) {
            console.error('❌ Ошибка подключения к Twitch EventSub:', error);
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

                // Отправляем welcome сообщение, так как стрим уже идёт
                console.error(`📣 Отправляем welcome сообщение...`);
                await this.sendWelcomeMessage();

                // Запускаем повтор welcome сообщения
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
        } catch (error) {
            console.error('❌ Ошибка при отправке уведомления:', error);

            // Даже при ошибке пытаемся отправить минимальное уведомление
            try {
                const fallbackMessage = `🟢 <b>Стрим начался на канале ${event.broadcasterDisplayName}!</b>\n\n🔗 <a href="https://twitch.tv/${event.broadcasterName}">${event.broadcasterDisplayName}</a>`;
                await this.telegram.sendMessage(telegramChannelId, fallbackMessage, {
                    parse_mode: 'HTML',
                    link_preview_options: {is_disabled: false}
                });
                console.error('✅ Резервное уведомление отправлено');
            } catch (fallbackError) {
                console.error('❌ Даже резервное уведомление не удалось отправить:', fallbackError);
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
        this.currentStreamStats = {
            startTime: startDate,
            viewerCounts: [],
            broadcasterId,
            broadcasterName
        };

        console.error('📊 Запущено отслеживание количества зрителей (опрос каждую минуту)');
        console.error(`⏱️  Время начала стрима: ${startDate.toLocaleString('ru-RU')}`);

        // Запускаем таймер для опроса каждую минуту
        this.viewerCountInterval = setInterval(async () => {
            await this.fetchAndRecordViewerCount();
        }, 60000);

        // Первый опрос сразу
        this.fetchAndRecordViewerCount();
    }

    public setOnStreamOfflineCallback(cb: () => void) {
        this.onStreamOfflineCallback = cb;
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

        // Выводим статистику в консоль
        console.error('\n📊 ===== СТАТИСТИКА СТРИМА =====');
        console.error(`👤 Канал: ${broadcasterName}`);
        console.error(`⏱️  Длительность: ${stats.duration}`);
        console.error(`👥 Пик зрителей: ${stats.peak}`);
        console.error(`📊 Всего замеров: ${this.currentStreamStats.viewerCounts.length}`);
        console.error('================================\n');

        // Очищаем данные
        this.currentStreamStats = null;

        return {stats, broadcasterName};
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
            return {peak: 0, duration: '0мин'};
        }

        const counts = this.currentStreamStats.viewerCounts;
        const peak = Math.max(...counts);

        // Подсчет длительности
        const durationMs = Date.now() - this.currentStreamStats.startTime.getTime();
        const hours = Math.floor(durationMs / 3600000);
        const minutes = Math.floor((durationMs % 3600000) / 60000);
        const duration = hours > 0 ? `${hours}ч ${minutes}мин` : `${minutes}мин`;

        return {peak, duration};
    }

    /**
     * Обработчик события завершения стрима
     */
    private async handleStreamOffline(event: any, telegramChannelId?: string, result?: StopTrackingResult | null) {
        console.error(`⚫ Стрим завершён: ${event.broadcasterDisplayName}`);

        // Отправляем уведомление о завершении со статистикой
        if (telegramChannelId && result) {
            try {
                const {stats} = result;

                const message = [
                    `🔴 Стрим <a href="https://twitch.tv/${event.broadcasterName}">${event.broadcasterDisplayName}</a> закончился`,
                    ``,
                    `   <b>Максимум зрителей:</b> ${stats.peak}`,
                    `   <b>Продолжительность:</b> ${stats.duration}`
                ].join('\n');

                await this.telegram.sendMessage(telegramChannelId, message, {
                    parse_mode: 'HTML',
                    link_preview_options: {is_disabled: true}
                });

                console.error('✅ Уведомление об окончании стрима отправлено в Telegram');
            } catch (error) {
                console.error('❌ Ошибка при отправке уведомления об окончании:', error);
            }
        }
    }

    /**
     * Отправляет приветственное сообщение (обычный текст) в чат
     * @param force - если true, отправляет независимо от времени последней отправки
     */
    private async sendWelcomeMessage(force: boolean = false): Promise<void> {
        if (!ENABLE_BOT_FEATURES) {
            console.log('⚠️ Welcome сообщения отключены (ENABLE_BOT_FEATURES=false)');
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
                // Время уже прошло, отправляем сразу
                initialDelay = 0;
                console.log(`🔁 Welcome сообщение: пора отправить (прошло ${Math.floor(timeSinceLastSent / 60000)} мин)`);
            }
        } else {
            console.log(`🔁 Welcome сообщение каждые ${mins} мин (${hours}ч)`);
        }

        // Первый вызов через вычисленную задержку, потом каждые N минут
        const runMessage = async () => {
            console.log('🔄 Повтор welcome сообщения...');
            await this.sendWelcomeMessage(true); // force=true для интервала

            console.log('🔄 Сброс таймера ротации ссылок (следующая ссылка через 15 мин)...');
            this.stopLinkRotation();
            this.startLinkRotation(true);
        };

        if (initialDelay === 0) {
            runMessage();
            this.welcomeInterval = setInterval(runMessage, ANNOUNCEMENT_REPEAT_INTERVAL_MS);
        } else {
            setTimeout(async () => {
                await runMessage();
                this.welcomeInterval = setInterval(runMessage, ANNOUNCEMENT_REPEAT_INTERVAL_MS);
            }, initialDelay);
        }
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
     * Запускает ротацию ссылок (через 15 минут после начала, затем каждые 15 минут)
     * Учитывает время последней отправки для синхронизации
     * @param force - если true, игнорирует lastLinkAnnouncementAt и запускает с полной задержкой
     */
    private startLinkRotation(force: boolean = false): void {
        this.stopLinkRotation();

        const mins = LINK_ROTATION_INTERVAL_MS / 60000;
        
        // Вычисляем когда следующая отправка
        const now = Date.now();
        const lastSent = this.announcementState.lastLinkAnnouncementAt;
        let initialDelay = LINK_ROTATION_INTERVAL_MS;

        // Если force=true, всегда используем полный интервал (игнорируем lastSent)
        if (force) {
            initialDelay = LINK_ROTATION_INTERVAL_MS;
            console.log(`🔄 Ротация ссылок: принудительный сброс, следующая через ${mins} мин`);
        } else if (lastSent) {
            const timeSinceLastSent = now - lastSent;
            const remaining = LINK_ROTATION_INTERVAL_MS - timeSinceLastSent;
            
            if (remaining > 0) {
                initialDelay = remaining;
                console.log(`🔄 Ротация ссылок: последняя отправка ${Math.floor(timeSinceLastSent / 60000)} мин назад, следующая через ${Math.ceil(remaining / 60000)} мин`);
            } else {
                // Время уже прошло, отправляем сразу
                initialDelay = 1000; // небольшая задержка
                console.log(`🔄 Ротация ссылок: пора отправить (прошло ${Math.floor(timeSinceLastSent / 60000)} мин)`);
            }
        } else {
            console.log(`🔄 Ротация ссылок запустится через ${mins} мин, затем каждые ${mins} мин`);
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

        // Очищаем timeout (первая отправка через 15 минут)
        if (this.linkRotationTimeout) {
            clearTimeout(this.linkRotationTimeout);
            this.linkRotationTimeout = null;
        }

        // Очищаем interval (повторы каждые 15 минут)
        if (this.linkRotationInterval) {
            clearInterval(this.linkRotationInterval);
            this.linkRotationInterval = null;
        }

        // Сбрасываем индекс, если что-то было активно
        if (hadTimeout || hadInterval) {
            this.currentLinkIndex = 0;
            console.log('⏹️ Ротация ссылок остановлена');
        }
    }

    /**
     * Отправляет следующий announcement из ротации ссылок
     */
    private async sendNextLinkAnnouncement(): Promise<void> {
        if (!ENABLE_BOT_FEATURES) {
            console.log('⚠️ Ротация ссылок отключена (ENABLE_BOT_FEATURES=false)');
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
     * Отключение от EventSub
     */
    async disconnect(): Promise<void> {
        try {
            this.isStreamOnline = false;
            this.stopViewerCountTracking();
            this.stopWelcomeMessageInterval();
            this.stopLinkRotation();

            if (this.listener) {
                await this.listener.stop();
                console.error('🛑 Отключено от Twitch EventSub');
            }
        } catch (error) {
            console.error('❌ Ошибка при отключении от Twitch EventSub:', error);
        }
    }

    /**
     * Проверка, онлайн ли сейчас стрим
     */
    public getStreamStatus(): boolean {
        return this.isStreamOnline;
    }
}
