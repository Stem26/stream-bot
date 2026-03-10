/**
 * Нативная реализация Twitch EventSub WebSocket (без Twurple)
 * Решает проблему с 429 ошибками и множественными транспортами
 */

import WebSocket from 'ws';
import type { Telegram } from 'telegraf';
import { ENABLE_BOT_FEATURES } from '../config/features';
import { IS_LOCAL } from '../config/env';
import { addStreamToHistory } from '../storage/stream-history';
import { log } from '../utils/event-logger';
import * as fs from 'fs';
import * as path from 'path';

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

const ANNOUNCEMENT_STATE_FILE = path.join(MONOREPO_ROOT, 'announcement-state.json');

interface AnnouncementState {
    lastWelcomeAnnouncementAt: number | null;
    lastLinkAnnouncementAt: number | null;
    currentLinkIndex: number;
    currentStreamPeak: number | null;
    currentStreamStartTime: number | null;
    currentStreamFollowsCount: number | null;
}

function loadAnnouncementState(): AnnouncementState {
    const defaultState: AnnouncementState = {
        lastWelcomeAnnouncementAt: null,
        lastLinkAnnouncementAt: null,
        currentLinkIndex: 0,
        currentStreamPeak: null,
        currentStreamStartTime: null,
        currentStreamFollowsCount: null
    };

    try {
        if (fs.existsSync(ANNOUNCEMENT_STATE_FILE)) {
            const data = fs.readFileSync(ANNOUNCEMENT_STATE_FILE, 'utf-8');
            const loadedState = JSON.parse(data);
            return { ...defaultState, ...loadedState };
        }
    } catch (error) {
        console.error('⚠️ Ошибка загрузки состояния announcements:', error);
    }

    return defaultState;
}

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
    { message: '💖Donation (шанс, что приду): https://donatex.gg/donate/kunilika666', color: 'orange' as const },
    { message: '📸Boosty (запретные фото): https://boosty.to/kunilika911', color: 'purple' as const },
    { message: '🔮Telegram (тайная жизнь): http://t.me/+rSBrR1FyQqBhZmU1', color: 'blue' as const },
    { message: '🎁Fetta (исполни желание): https://fetta.app/u/kunilika666', color: 'green' as const }
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

export class TwitchEventSubNative {
    private ws: WebSocket | null = null;
    private sessionId: string | null = null;
    private subscriptionsCreated: boolean = false;
    private telegram: Telegram;
    private accessToken: string = '';
    private clientId: string = '';
    private broadcasterId: string = '';
    private moderatorId: string = '';
    private broadcasterName: string = '';
    private telegramChannelId?: string;
    private telegramChatId?: string;

    private isStreamOnline: boolean = false;
    private currentStreamStats: StreamStats | null = null;
    private announcementState: AnnouncementState;

    private welcomeInterval: NodeJS.Timeout | null = null;
    private linkRotationInterval: NodeJS.Timeout | null = null;
    private linkRotationTimeout: NodeJS.Timeout | null = null;
    private currentLinkIndex: number = 0;

    private chatSender: ((channel: string, message: string) => Promise<void>) | null = null;
    private channelName: string = '';

    private onStreamOfflineCallback: (() => void) | null = null;
    private onStreamOnlineCallback: (() => void) | null = null;

    private keepAliveInterval: NodeJS.Timeout | null = null;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private reconnectDelay: number = 5000;
    private lastKeepaliveStatus: 'active' | 'error' | null = null;

    constructor(telegram: Telegram) {
        this.telegram = telegram;
        this.announcementState = loadAnnouncementState();
        this.currentLinkIndex = this.announcementState.currentLinkIndex;
        console.log('📋 Загружено состояние announcements:', this.announcementState);

        process.once('SIGINT', () => this.handleShutdown('SIGINT'));
        process.once('SIGTERM', () => this.handleShutdown('SIGTERM'));
    }

    private async handleShutdown(signal: string) {
        console.log(`🛑 ${signal} — закрываем EventSub WebSocket`);
        await this.disconnect();
        console.log('✅ EventSub WebSocket остановлен');
    }

    async connect(
        channelName: string,
        accessToken: string,
        clientId: string,
        telegramChannelId?: string,
        telegramChatId?: string
    ): Promise<boolean> {
        try {
            this.accessToken = accessToken;
            this.clientId = clientId;
            this.channelName = channelName;
            this.telegramChannelId = telegramChannelId;
            this.telegramChatId = telegramChatId;

            const userResponse = await fetch(`https://api.twitch.tv/helix/users?login=${channelName}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Client-Id': clientId
                }
            });

            if (!userResponse.ok) {
                throw new Error(`Ошибка получения пользователя: ${userResponse.status}`);
            }

            const userData = await userResponse.json() as { data: Array<{ id: string; display_name: string }> };
            if (!userData.data || userData.data.length === 0) {
                throw new Error(`Пользователь ${channelName} не найден`);
            }

            this.broadcasterId = userData.data[0].id;
            this.broadcasterName = userData.data[0].display_name;
            console.log(`✅ Найден канал: ${this.broadcasterName} (ID: ${this.broadcasterId})`);

            const validateRes = await fetch('https://id.twitch.tv/oauth2/validate', {
                headers: { 'Authorization': `OAuth ${accessToken}` }
            });

            if (validateRes.ok) {
                const validateData = await validateRes.json() as { user_id: string };
                this.moderatorId = validateData.user_id;
            }

            await this.connectWebSocket();

            log('CONNECTION', {
                service: 'TwitchEventSubNative',
                status: 'connected',
                channel: channelName
            });

            return true;
        } catch (error: any) {
            console.error('❌ Ошибка подключения к Twitch EventSub:', error);
            log('ERROR', {
                context: 'TwitchEventSubNative.connect',
                error: error?.message || String(error),
                stack: error?.stack,
                channel: channelName
            });
            return false;
        }
    }

    private async connectWebSocket(): Promise<void> {
        return new Promise((resolve, reject) => {
            console.log('🔌 Подключаемся к Twitch EventSub WebSocket...');

            this.ws = new WebSocket('wss://eventsub.wss.twitch.tv/ws');

            this.ws.on('open', () => {
                console.log('✅ WebSocket соединение установлено');
                log('EVENTSUB_WEBSOCKET', { status: 'connected' });
                this.lastKeepaliveStatus = 'active';
            });

            this.ws.on('message', async (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    await this.handleMessage(message);

                    if (message.metadata?.message_type === 'session_welcome') {
                        resolve();
                    }
                } catch (error) {
                    console.error('❌ Ошибка обработки сообщения:', error);
                }
            });

            this.ws.on('error', (error) => {
                console.error('❌ WebSocket ошибка:', error);
                log('ERROR', {
                    context: 'TwitchEventSubNative.WebSocket',
                    error: error.message
                });
                this.lastKeepaliveStatus = 'error';
                reject(error);
            });

            this.ws.on('close', (code, reason) => {
                console.log(`⚫ WebSocket закрыт: ${code} ${reason.toString()}`);
                log('EVENTSUB_WEBSOCKET', {
                    status: 'closed',
                    code,
                    reason: reason.toString()
                });
                this.lastKeepaliveStatus = null;
                this.handleDisconnect();
            });

            setTimeout(() => reject(new Error('WebSocket connection timeout')), 30000);
        });
    }

    private async handleMessage(message: any): Promise<void> {
        const messageType = message.metadata?.message_type;

        switch (messageType) {
            case 'session_welcome':
                await this.handleSessionWelcome(message);
                break;

            case 'session_keepalive':
                // Логируем только изменение статуса
                if (this.lastKeepaliveStatus !== 'active') {
                    console.log('💓 Keepalive восстановлен');
                    log('EVENTSUB_KEEPALIVE', { status: 'active' });
                    this.lastKeepaliveStatus = 'active';
                }
                break;

            case 'notification':
                await this.handleNotification(message);
                break;

            case 'session_reconnect':
                console.log('🔄 Сервер запросил reconnect');
                await this.handleReconnect(message.payload.session.reconnect_url);
                break;

            default:
                console.log('❓ Неизвестный тип сообщения:', messageType);
        }
    }

    private async handleSessionWelcome(message: any): Promise<void> {
        this.sessionId = message.payload.session.id;
        const keepaliveTimeout = message.payload.session.keepalive_timeout_seconds;

        console.log(`✅ Session ID получен: ${this.sessionId}`);
        console.log(`⏱️  Keepalive timeout: ${keepaliveTimeout}s`);

        this.startKeepAliveMonitor(keepaliveTimeout);

        // Защита от повторного создания подписок
        if (!this.subscriptionsCreated) {
            await this.subscribeToEvents();
            this.subscriptionsCreated = true;
        } else {
            console.log('ℹ️ Подписки уже созданы, пропускаем');
        }

        await this.checkCurrentStreamStatus();
    }

    private startKeepAliveMonitor(timeoutSeconds: number): void {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
        }

        const checkInterval = (timeoutSeconds / 2) * 1000;
        this.keepAliveInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                // Логируем только восстановление после ошибки
                if (this.lastKeepaliveStatus === 'error') {
                    console.log('✅ WebSocket восстановлен');
                    log('EVENTSUB_KEEPALIVE', { status: 'recovered' });
                    this.lastKeepaliveStatus = 'active';
                }
            } else {
                // Логируем только появление ошибки
                if (this.lastKeepaliveStatus !== 'error') {
                    console.error('⚠️ WebSocket не активен, требуется переподключение');
                    log('EVENTSUB_KEEPALIVE', { status: 'error', message: 'WebSocket not active' });
                    this.lastKeepaliveStatus = 'error';
                }
                this.handleDisconnect();
            }
        }, checkInterval);
    }

    private async subscribeToEvents(): Promise<void> {
        console.log('📝 Подписываемся на события...');

        await this.subscribe('stream.online', { broadcaster_user_id: this.broadcasterId });
        await this.subscribe('stream.offline', { broadcaster_user_id: this.broadcasterId });
        
        // channel.follow требует scope: moderator:read:followers
        // Если токен не имеет этого scope, подписка будет пропущена
        try {
            await this.subscribe('channel.follow', {
                broadcaster_user_id: this.broadcasterId,
                moderator_user_id: this.moderatorId
            });
            console.log('📋 Подписки EventSub зарегистрированы:');
            console.log('   • stream.online');
            console.log('   • stream.offline');
            console.log('   • channel.follow');
        } catch (error: any) {
            console.warn('⚠️ Не удалось подписаться на channel.follow (возможно нет scope: moderator:read:followers)');
            console.warn(`   Причина: ${error.message}`);
            console.log('📋 Подписки EventSub зарегистрированы:');
            console.log('   • stream.online');
            console.log('   • stream.offline');
        }
    }

    private async subscribe(type: string, condition: any): Promise<void> {
        try {
            const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Client-Id': this.clientId,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    type,
                    version: type === 'channel.follow' ? '2' : '1',
                    condition,
                    transport: {
                        method: 'websocket',
                        session_id: this.sessionId
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Ошибка подписки на ${type}: ${response.status} ${errorText}`);
            }

            console.log(`✅ Подписка на ${type} создана`);
        } catch (error: any) {
            console.error(`❌ Ошибка подписки на ${type}:`, error.message);
            throw error;
        }
    }

    private async handleNotification(message: any): Promise<void> {
        const eventType = message.payload.subscription.type;
        const event = message.payload.event;

        console.log(`📨 Событие: ${eventType}`);
        log('EVENTSUB_NOTIFICATION', { type: eventType });

        switch (eventType) {
            case 'stream.online':
                await this.handleStreamOnline(event);
                break;

            case 'stream.offline':
                await this.handleStreamOffline(event);
                break;

            case 'channel.follow':
                await this.handleFollow(event);
                break;

            default:
                console.log('❓ Неизвестное событие:', eventType);
        }
    }

    private async handleStreamOnline(event: any): Promise<void> {
        try {
            this.onStreamOnlineCallback?.();
            console.log('✅ Синхронизация зрителей запущена при начале стрима');
        } catch (e) {
            console.error('❌ Ошибка при запуске синхронизации зрителей:', e);
        }

        if (this.isStreamOnline) {
            console.error(`⚠️ Стрим уже онлайн, пропускаем дубль события`);
            return;
        }

        console.error(`🔴 Стрим начался на канале ${event.broadcaster_user_name}!`);
        this.isStreamOnline = true;

        this.announcementState.currentStreamPeak = null;
        this.announcementState.currentStreamStartTime = Date.now();
        saveAnnouncementState(this.announcementState);

        log('STREAM_ONLINE', { channel: event.broadcaster_user_name });

        await this.sendWelcomeMessage();
        this.startWelcomeMessageInterval();
        this.startLinkRotation(true);

        if (this.telegramChannelId) {
            await this.sendTelegramStreamNotification(event);
        }

        const startDate = new Date(event.started_at);
        this.startViewerCountTracking(event.broadcaster_user_id, event.broadcaster_user_name, startDate);
    }

    private async handleStreamOffline(event: any): Promise<void> {
        console.error(`⚫ Стрим завершился на канале ${event.broadcaster_user_name}`);
        this.isStreamOnline = false;

        try {
            this.onStreamOfflineCallback?.();
            console.log('🧹 Очередь дуэлей очищена (стрим оффлайн)');
        } catch (e) {
            console.error('❌ Ошибка при очистке очереди дуэлей:', e);
        }

        this.stopWelcomeMessageInterval();
        this.stopLinkRotation();

        const result = this.stopViewerCountTracking();

        log('STREAM_OFFLINE', { channel: event.broadcaster_user_name });

        if (this.telegramChatId && result) {
            await this.sendTelegramOfflineNotification(event, result);
        }

        if (result) {
            await this.saveStreamHistory(result);
        }
    }

    private async handleFollow(event: any): Promise<void> {
        console.log(`💜 Новый фоловер: ${event.user_name}`);

        if (this.isStreamOnline && this.currentStreamStats) {
            this.currentStreamStats.followsCount++;
            console.log(`📊 Follow за стрим: ${this.currentStreamStats.followsCount}`);

            this.announcementState.currentStreamFollowsCount = this.currentStreamStats.followsCount;
            saveAnnouncementState(this.announcementState);
        } else {
            console.log(`ℹ️ Follow получен вне стрима, не учитывается в статистике`);
        }

        if (!ENABLE_BOT_FEATURES) {
            console.log('🔇 Благодарности за Follow отключены');
            return;
        }

        const { ALLOW_LOCAL_COMMANDS } = require('../config/features');
        if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) {
            console.log('🔒 Локально благодарности за Follow заблокированы');
            return;
        }

        if (this.chatSender && this.channelName) {
            try {
                await this.chatSender(this.channelName, `${event.user_name} спасибо за follow❤️`);
                console.log(`✅ Отправлена благодарность за Follow: ${event.user_name}`);
            } catch (error) {
                console.error('❌ Ошибка отправки благодарности за Follow:', error);
            }
        }
    }

    private async handleReconnect(reconnectUrl: string): Promise<void> {
        console.log('🔄 Переподключение к новому WebSocket...');

        if (this.ws) {
            this.ws.close();
        }

        this.ws = new WebSocket(reconnectUrl);

        this.ws.on('open', () => {
            console.log('✅ Переподключение успешно');
            log('EVENTSUB_WEBSOCKET', { status: 'reconnected' });
            this.lastKeepaliveStatus = 'active';
        });

        this.ws.on('message', async (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());
                await this.handleMessage(message);
            } catch (error) {
                console.error('❌ Ошибка обработки сообщения:', error);
            }
        });

        this.ws.on('error', (error) => {
            console.error('❌ WebSocket ошибка:', error);
            log('ERROR', {
                context: 'TwitchEventSubNative.Reconnect',
                error: error.message
            });
            this.lastKeepaliveStatus = 'error';
        });

        this.ws.on('close', (code, reason) => {
            console.log(`⚫ WebSocket закрыт: ${code} ${reason.toString()}`);
            log('EVENTSUB_WEBSOCKET', {
                status: 'closed_after_reconnect',
                code,
                reason: reason.toString()
            });
            this.lastKeepaliveStatus = null;
            this.handleDisconnect();
        });
    }

    private handleDisconnect(): void {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.reconnectDelay * this.reconnectAttempts;

            console.log(`🔄 Попытка переподключения ${this.reconnectAttempts}/${this.maxReconnectAttempts} через ${delay}ms`);
            log('EVENTSUB_RECONNECT', {
                attempt: this.reconnectAttempts,
                maxAttempts: this.maxReconnectAttempts,
                delayMs: delay
            });

            setTimeout(async () => {
                try {
                    await this.connectWebSocket();
                    this.reconnectAttempts = 0;
                    console.log('✅ Переподключение успешно завершено');
                    log('EVENTSUB_RECONNECT', { status: 'success' });
                } catch (error) {
                    console.error('❌ Ошибка переподключения:', error);
                    log('ERROR', {
                        context: 'TwitchEventSubNative.handleDisconnect',
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }, delay);
        } else {
            console.error('❌ Превышено максимальное количество попыток переподключения');
            log('ERROR', {
                context: 'TwitchEventSubNative.handleDisconnect',
                error: 'Max reconnect attempts exceeded'
            });
        }
    }

    private async checkCurrentStreamStatus(): Promise<void> {
        try {
            const response = await fetch(`https://api.twitch.tv/helix/streams?user_id=${this.broadcasterId}`, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Client-Id': this.clientId
                }
            });

            if (!response.ok) {
                throw new Error(`Ошибка получения статуса стрима: ${response.status}`);
            }

            const data = await response.json() as { data: any[] };

            if (data.data && data.data.length > 0) {
                const stream = data.data[0];
                console.error(`📊 Статус стрима: 🟢 В ЭФИРЕ`);
                console.error(`   🎮 Игра: ${stream.game_name || 'Не указана'}`);
                console.error(`   📝 Название: ${stream.title}`);
                console.error(`   👥 Зрителей: ${stream.viewer_count}`);

                this.isStreamOnline = true;

                try {
                    this.onStreamOnlineCallback?.();
                    console.log('✅ Синхронизация зрителей запущена (стрим уже онлайн)');
                } catch (e) {
                    console.error('❌ Ошибка при запуске синхронизации зрителей:', e);
                }

                await this.sendWelcomeMessage(false);
                this.startWelcomeMessageInterval();
                this.startLinkRotation();

                const startDate = new Date(stream.started_at);
                this.startViewerCountTracking(this.broadcasterId, this.broadcasterName, startDate);
            } else {
                console.error(`📊 Статус стрима: 🔴 Оффлайн`);
            }
        } catch (error) {
            console.error('⚠️ Не удалось получить статус стрима:', error);
        }
    }

    private startViewerCountTracking(broadcasterId: string, broadcasterName: string, startDate: Date): void {
        if (this.currentStreamStats) {
            console.error('⚠️ Отслеживание зрителей уже запущено, пропускаем');
            return;
        }

        const initialCounts: number[] = [];

        if (this.announcementState.currentStreamPeak !== null) {
            initialCounts.push(this.announcementState.currentStreamPeak);
            console.error(`🔄 Восстановлен пик зрителей из файла: ${this.announcementState.currentStreamPeak}`);
        }

        const restoredFollowsCount = this.announcementState.currentStreamFollowsCount ?? 0;
        if (restoredFollowsCount > 0) {
            console.error(`🔄 Восстановлен счётчик подписчиков из файла: ${restoredFollowsCount}`);
        }

        this.currentStreamStats = {
            startTime: startDate,
            viewerCounts: initialCounts,
            broadcasterId,
            broadcasterName,
            followsCount: restoredFollowsCount
        };

        console.error('📊 Запущено отслеживание количества зрителей');
        console.error(`⏱️  Время начала стрима: ${startDate.toLocaleString('ru-RU')}`);
    }

    private stopViewerCountTracking(): any {
        if (!this.currentStreamStats || this.currentStreamStats.viewerCounts.length === 0) {
            this.currentStreamStats = null;
            return null;
        }

        const stats = this.calculateStreamStats();
        const broadcasterName = this.currentStreamStats.broadcasterName;
        const startTime = this.currentStreamStats.startTime;

        console.error('\n📊 ===== СТАТИСТИКА СТРИМА =====');
        console.error(`👤 Канал: ${broadcasterName}`);
        console.error(`⏱️  Длительность: ${stats.duration}`);
        console.error(`👥 Пик зрителей: ${stats.peak}`);
        console.error(`💜 Новых follow: ${stats.followsCount}`);
        console.error('================================\n');

        this.currentStreamStats = null;

        return {
            stats: { ...stats, startTime },
            broadcasterName
        };
    }

    private calculateStreamStats() {
        if (!this.currentStreamStats || this.currentStreamStats.viewerCounts.length === 0) {
            return { peak: 0, duration: '0мин', followsCount: 0 };
        }

        const counts = this.currentStreamStats.viewerCounts.filter(c => typeof c === 'number' && !isNaN(c));
        const peak = counts.length > 0 ? Math.max(...counts) : 0;

        const durationMs = Date.now() - this.currentStreamStats.startTime.getTime();
        const hours = Math.floor(durationMs / 3600000);
        const minutes = Math.floor((durationMs % 3600000) / 60000);
        const duration = hours > 0 ? `${hours}ч ${minutes}мин` : `${minutes}мин`;

        return { peak, duration, followsCount: this.currentStreamStats.followsCount };
    }

    public async recordViewersNow(chattersCount?: number): Promise<void> {
        if (!this.isStreamOnline || !this.currentStreamStats) {
            return;
        }

        try {
            const response = await fetch(`https://api.twitch.tv/helix/streams?user_id=${this.currentStreamStats.broadcasterId}`, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Client-Id': this.clientId
                }
            });

            if (!response.ok) return;

            const data = await response.json() as { data: any[] };

            if (data.data && data.data.length > 0) {
                const viewersAPI = data.data[0].viewer_count;
                const actualViewers = chattersCount ? Math.max(viewersAPI, chattersCount) : viewersAPI;

                this.currentStreamStats.viewerCounts.push(actualViewers);

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
                }
            }
        } catch (error) {
            console.error('⚠️ Ошибка синхронизированного замера viewers:', error);
        }
    }

    private async sendTelegramStreamNotification(event: any): Promise<void> {
        if (!this.telegramChannelId) return;

        try {
            const response = await fetch(`https://api.twitch.tv/helix/streams?user_id=${event.broadcaster_user_id}`, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Client-Id': this.clientId
                }
            });

            let message: string;

            if (response.ok) {
                const data = await response.json() as { data: any[] };
                if (data.data && data.data.length > 0) {
                    const stream = data.data[0];
                    message = `
🟢 <b>Стрим начался!</b>

<b>Канал:</b> ${event.broadcaster_user_name}
<b>Категория:</b> ${stream.game_name || 'Не указана'}
<b>Название:</b> ${stream.title}

🔗 <a href="https://twitch.tv/${event.broadcaster_user_login}">${event.broadcaster_user_name}</a>
                    `.trim();
                } else {
                    message = `
🟢 <b>Стрим начался!</b>

<b>Канал:</b> ${event.broadcaster_user_name}

🔗 <a href="https://twitch.tv/${event.broadcaster_user_login}">${event.broadcaster_user_name}</a>
                    `.trim();
                }
            } else {
                message = `
🟢 <b>Стрим начался!</b>

<b>Канал:</b> ${event.broadcaster_user_name}

🔗 <a href="https://twitch.tv/${event.broadcaster_user_login}">${event.broadcaster_user_name}</a>
                `.trim();
            }

            await this.telegram.sendMessage(this.telegramChannelId, message, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: false }
            });

            console.error('✅ Уведомление о начале стрима отправлено в Telegram');
        } catch (error) {
            console.error('❌ Ошибка при отправке уведомления:', error);
        }
    }

    private async sendTelegramOfflineNotification(event: any, result: any): Promise<void> {
        if (!this.telegramChatId) return;

        try {
            const { stats } = result;
            const message = [
                `🔴 Стрим <a href="https://twitch.tv/${event.broadcaster_user_login}">${event.broadcaster_user_name}</a> закончился`,
                ``,
                `   <b>Максимум зрителей:</b> ${stats.peak}`,
                `   <b>Продолжительность:</b> ${stats.duration}`,
                `   <b>Новых follow:</b> ${stats.followsCount}`
            ].join('\n');

            await this.telegram.sendMessage(this.telegramChatId, message, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true }
            });

            console.error('✅ Уведомление об окончании стрима отправлено в Telegram');

            const adminChatId = process.env.BACKUP_ADMIN_ID;
            if (adminChatId) {
                console.log('📦 Создание бэкапа БД после окончания стрима...');
                const { exec } = require('child_process');
                const backupScript = require('path').join(MONOREPO_ROOT, 'scripts', 'backup-db.js');
                exec(`node "${backupScript}" ${adminChatId}`, (error: any, stdout: any) => {
                    if (error) {
                        console.error('❌ Ошибка создания бэкапа:', error.message);
                    } else {
                        console.log('✅ Бэкап БД создан и отправлен админу');
                        if (stdout) console.log(stdout);
                    }
                });
            }
        } catch (error) {
            console.error('❌ Ошибка при отправке уведомления об окончании:', error);
        }
    }

    private async saveStreamHistory(result: any): Promise<void> {
        try {
            const { stats } = result;

            const mskTime = new Date(stats.startTime.getTime() + 3 * 60 * 60 * 1000);
            const dateStr = mskTime.toISOString().split('T')[0];
            const timeStr = mskTime.toISOString().split('T')[1].substring(0, 5) + ' МСК';

            await addStreamToHistory({
                date: dateStr,
                startTime: timeStr,
                duration: stats.duration,
                peakViewers: stats.peak,
                followsCount: stats.followsCount
            });

            this.announcementState.currentStreamPeak = null;
            this.announcementState.currentStreamStartTime = null;
            this.announcementState.currentStreamFollowsCount = null;
            saveAnnouncementState(this.announcementState);
            console.log('🔄 Статистика текущего стрима сброшена (стрим завершён)');
        } catch (error) {
            console.error('❌ Ошибка при сохранении истории стрима:', error);
        }
    }

    private async sendWelcomeMessage(force: boolean = false): Promise<void> {
        if (!this.isStreamOnline) return;
        if (!ENABLE_BOT_FEATURES) return;

        const { ALLOW_LOCAL_COMMANDS } = require('../config/features');
        if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) return;

        if (!this.chatSender || !this.channelName) return;

        const now = Date.now();
        const lastSent = this.announcementState.lastWelcomeAnnouncementAt;
        const timeSinceLastSent = lastSent ? now - lastSent : Infinity;
        const minInterval = ANNOUNCEMENT_REPEAT_INTERVAL_MS * 0.9;

        if (!force && lastSent && timeSinceLastSent < minInterval) {
            const remainingMins = Math.ceil((minInterval - timeSinceLastSent) / 60000);
            console.log(`⏳ Welcome сообщение пропущено: осталось ~${remainingMins} мин`);
            return;
        }

        try {
            await this.chatSender(this.channelName, STREAM_WELCOME_MESSAGE);
            this.announcementState.lastWelcomeAnnouncementAt = now;
            saveAnnouncementState(this.announcementState);
            console.log('✅ Приветственное сообщение отправлено в чат!');
        } catch (error) {
            console.error('❌ Ошибка при отправке приветственного сообщения:', error);
        }
    }

    private startWelcomeMessageInterval(): void {
        this.stopWelcomeMessageInterval();

        const now = Date.now();
        const lastSent = this.announcementState.lastWelcomeAnnouncementAt;
        let initialDelay = ANNOUNCEMENT_REPEAT_INTERVAL_MS;

        if (lastSent) {
            const timeSinceLastSent = now - lastSent;
            const remaining = ANNOUNCEMENT_REPEAT_INTERVAL_MS - timeSinceLastSent;

            if (remaining > 0) {
                initialDelay = remaining;
                console.log(`🔁 Welcome сообщение: следующая через ${Math.ceil(remaining / 60000)} мин`);
            } else {
                initialDelay = 5000;
            }
        }

        const runMessage = async () => {
            await this.sendWelcomeMessage(true);
        };

        setTimeout(async () => {
            await runMessage();
            this.welcomeInterval = setInterval(runMessage, ANNOUNCEMENT_REPEAT_INTERVAL_MS);
        }, initialDelay);
    }

    private stopWelcomeMessageInterval(): void {
        if (this.welcomeInterval) {
            clearInterval(this.welcomeInterval);
            this.welcomeInterval = null;
        }
    }

    private startLinkRotation(force: boolean = false): void {
        this.stopLinkRotation();

        const mins = LINK_ROTATION_INTERVAL_MS / 60000;
        const initialDelay = LINK_ROTATION_INTERVAL_MS;

        console.log(`🔄 Ротация ссылок: первая через ${mins} мин, затем каждые ${mins} мин`);

        this.linkRotationTimeout = setTimeout(() => {
            this.sendNextLinkAnnouncement();
            this.linkRotationInterval = setInterval(() => {
                this.sendNextLinkAnnouncement();
            }, LINK_ROTATION_INTERVAL_MS);
        }, initialDelay);
    }

    private stopLinkRotation(): void {
        if (this.linkRotationTimeout) {
            clearTimeout(this.linkRotationTimeout);
            this.linkRotationTimeout = null;
        }

        if (this.linkRotationInterval) {
            clearInterval(this.linkRotationInterval);
            this.linkRotationInterval = null;
            this.currentLinkIndex = 0;
            this.announcementState.currentLinkIndex = 0;
            saveAnnouncementState(this.announcementState);
        }
    }

    private async sendNextLinkAnnouncement(): Promise<void> {
        if (!this.isStreamOnline) return;
        if (!ENABLE_BOT_FEATURES) return;

        const { ALLOW_LOCAL_COMMANDS } = require('../config/features');
        if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) return;

        if (!this.accessToken || !this.clientId || !this.broadcasterId || !this.moderatorId) return;

        const currentLink = LINK_ANNOUNCEMENTS[this.currentLinkIndex];

        try {
            console.log(`📣 Ротация ссылок [${this.currentLinkIndex + 1}/${LINK_ANNOUNCEMENTS.length}]: ${currentLink.message.split(':')[0]}`);

            const response = await fetch(
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

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Ошибка отправки announcement: ${response.status} ${errorText}`);
            }

            console.log(`✅ Link announcement отправлен (цвет: ${currentLink.color})`);

            this.currentLinkIndex = (this.currentLinkIndex + 1) % LINK_ANNOUNCEMENTS.length;
            this.announcementState.lastLinkAnnouncementAt = Date.now();
            this.announcementState.currentLinkIndex = this.currentLinkIndex;
            saveAnnouncementState(this.announcementState);
        } catch (error: any) {
            console.error('❌ Ошибка при отправке link announcement:', error.message);
        }
    }

    setChatSender(sender: (channel: string, message: string) => Promise<void>, channelName: string): void {
        this.chatSender = sender;
        this.channelName = channelName;

        if (this.isStreamOnline) {
            this.sendWelcomeMessage(false).catch(err => {
                console.error('❌ Ошибка отправки отложенного welcome:', err);
            });
        }
    }

    setOnStreamOfflineCallback(cb: () => void): void {
        this.onStreamOfflineCallback = cb;
    }

    setOnStreamOnlineCallback(cb: () => void): void {
        this.onStreamOnlineCallback = cb;
    }

    getStreamStatus(): boolean {
        return this.isStreamOnline;
    }

    async disconnect(): Promise<void> {
        try {
            this.isStreamOnline = false;
            this.stopWelcomeMessageInterval();
            this.stopLinkRotation();

            if (this.keepAliveInterval) {
                clearInterval(this.keepAliveInterval);
                this.keepAliveInterval = null;
            }

            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }

            console.error('🛑 Отключено от Twitch EventSub');
            log('CONNECTION', {
                service: 'TwitchEventSubNative',
                status: 'disconnected'
            });
        } catch (error: any) {
            console.error('❌ Ошибка при отключении от Twitch EventSub:', error);
        }
    }
}
