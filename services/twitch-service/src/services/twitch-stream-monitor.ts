import {ApiClient} from '@twurple/api';
import {StaticAuthProvider} from '@twurple/auth';
import {EventSubWsListener} from '@twurple/eventsub-ws';
import type {Telegram} from 'telegraf';

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
    private onStreamOfflineCallback: (() => void) | null = null;

    // Для отправки announcement
    private accessToken: string = '';
    private clientId: string = '';
    private broadcasterId: string = '';
    private moderatorId: string = '';

    constructor(telegram: Telegram) {
        this.telegram = telegram;
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

                // Отправляем приветственный announcement (все ссылки)
                await this.sendWelcomeAnnouncement();

                // Запускаем повтор welcome announcement каждый час
                this.startWelcomeAnnouncementInterval();

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
                this.stopWelcomeAnnouncementInterval();
                this.stopLinkRotation();

                const result = this.stopViewerCountTracking();
                await this.handleStreamOffline(event, telegramChannelId, result);
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

                // Отправляем welcome announcement, так как стрим уже идёт
                console.error(`📣 Отправляем welcome announcement...`);
                await this.sendWelcomeAnnouncement();

                // Запускаем повтор welcome announcement
                this.startWelcomeAnnouncementInterval();

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
     * Отправляет приветственное announcement (выделенное объявление) в чат
     */
    private async sendWelcomeAnnouncement(): Promise<void> {
        if (!this.accessToken || !this.clientId || !this.broadcasterId || !this.moderatorId) {
            console.error('⚠️ Нет данных для отправки announcement');
            return;
        }

        try {
            console.log('📣 Отправка приветственного announcement...');

            // Отправляем announcement - выделенное цветное сообщение
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
                        message: STREAM_WELCOME_MESSAGE,
                        color: 'purple' // blue, green, orange, purple, primary
                    })
                }
            );

            if (!announcementRes.ok) {
                const errorText = await announcementRes.text();
                throw new Error(`Ошибка отправки announcement: ${announcementRes.status} ${errorText}`);
            }

            console.log('✅ Announcement отправлен! (цвет: фиолетовый)');
            console.log('💡 Закрепите вручную: клик на сообщение → Pin Message');

        } catch (error: any) {
            console.error('❌ Ошибка при отправке announcement:', error.message || error);
        }
    }

    /**
     * Запускает повтор welcome announcement каждые N минут
     */
    private startWelcomeAnnouncementInterval(): void {
        // Останавливаем предыдущий интервал, если был
        this.stopWelcomeAnnouncementInterval();

        const mins = ANNOUNCEMENT_REPEAT_INTERVAL_MS / 60000;
        const hours = mins / 60;
        console.log(`🔁 Welcome announcement каждые ${mins} мин (${hours}ч)`);

        this.welcomeInterval = setInterval(async () => {
            console.log('🔄 Повтор welcome announcement...');
            await this.sendWelcomeAnnouncement();

            // Сбрасываем ротацию ссылок после welcome
            console.log('🔄 Сброс ротации ссылок после welcome...');
            this.stopLinkRotation();
            this.startLinkRotation();
        }, ANNOUNCEMENT_REPEAT_INTERVAL_MS);
    }

    /**
     * Останавливает повтор welcome announcement
     */
    private stopWelcomeAnnouncementInterval(): void {
        if (this.welcomeInterval) {
            clearInterval(this.welcomeInterval);
            this.welcomeInterval = null;
            console.log('⏹️ Повтор announcement остановлен');
        }
    }

    /**
     * Запускает ротацию ссылок (через 15 минут после начала, затем каждые 15 минут)
     */
    private startLinkRotation(): void {
        this.stopLinkRotation();

        const mins = LINK_ROTATION_INTERVAL_MS / 60000;
        console.log(`🔄 Ротация ссылок запустится через ${mins} мин, затем каждые ${mins} мин`);

        this.linkRotationTimeout = setTimeout(() => {
            this.sendNextLinkAnnouncement();

            this.linkRotationInterval = setInterval(() => {
                this.sendNextLinkAnnouncement();
            }, LINK_ROTATION_INTERVAL_MS);
        }, LINK_ROTATION_INTERVAL_MS);
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
            this.stopWelcomeAnnouncementInterval();
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
