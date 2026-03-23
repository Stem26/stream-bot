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
import { ApiBackoffGate, TwitchApiClient } from './twitch/twitch-api-client';
import { API_SKIP_EVENTS, handleApiResult as handleApiResultPolicy } from './twitch/twitch-api-policy';
import type { TwitchEventSubStreamOfflineEvent, TwitchEventSubStreamOnlineEvent } from './twitch/twitch-eventsub.types';
import { computeStreamStats, formatDuration } from './twitch/stream-tracker';
import { TelegramMessageBuilder, TelegramSender } from './twitch/telegram';
import { isApiOk, type ApiCallResult } from './twitch/twitch-api.types';

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

const ANNOUNCEMENT_REPEAT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_LINK_ROTATION_INTERVAL_MS = 13 * 60 * 1000;
const OFFLINE_STATUS_POLL_MS = 30 * 1000;
const OFFLINE_EVENT_TRIGGER_PROBE_COOLDOWN_MS = 15 * 1000;
const WATCHDOG_CHECK_INTERVAL_MS = 30 * 1000;
const WATCHDOG_DEGRADED_GRACE_MS = 7 * 60 * 1000;
const EVENTSUB_SILENCE_TIMEOUT_MS = 90 * 1000;
const STREAMS_API_MIN_INTERVAL_MS = 10 * 1000;
const STREAMS_API_MAX_BACKOFF_MS = 5 * 60 * 1000;
const ANNOUNCEMENTS_API_MAX_BACKOFF_MS = 2 * 60 * 1000;
const SKIP_LOG_THROTTLE_MS = 30_000;

export type LinkRotationItem = { message: string; color: string };

interface StreamStats {
    startTime: Date;
    viewerCounts: number[];
    broadcasterId: string;
    broadcasterName: string;
    followsCount: number;
}

interface StreamTrackingResult {
    stats: {
        peak: number;
        durationMs: number;
        duration: string;
        followsCount: number;
        startTime: Date;
    };
    broadcasterName: string;
}

export class TwitchEventSubNative {
    private readonly API_META = {
        streams: {
            skipEvent: API_SKIP_EVENTS.STREAMS,
            errorContext: 'TwitchEventSubNative.streamsApi'
        },
        announcements: {
            skipEvent: API_SKIP_EVENTS.ANNOUNCEMENTS,
            errorContext: 'TwitchEventSubNative.announcementsApi'
        }
    } as const;

    private ws: WebSocket | null = null;
    private sessionId: string | null = null;
    private subscriptionsCreated: boolean = false;
    /** Session id, для которого мы реально создали подписки EventSub (нужно пересоздавать при новом session_id). */
    private subscriptionsSessionId: string | null = null;
    private telegramSender: TelegramSender;
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

    private getLinkRotationItems: (() => Promise<LinkRotationItem[]>) | null = null;
    private getRotationIntervalMinutes: (() => Promise<number>) | null = null;
    private getRaidMessage: (() => Promise<string>) | null = null;
    private broadcastAccessToken: string | null = null;

    private keepAliveInterval: NodeJS.Timeout | null = null;
    private offlineProbeInterval: NodeJS.Timeout | null = null;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private reconnectDelay: number = 5000;
    private lastKeepaliveStatus: 'active' | 'error' | null = null;
    private statusProbeInFlight: boolean = false;
    private lastOfflineEventProbeAt: number = 0;
    private lastEventSubMessageAt: number = 0;
    private lastKeepaliveAt: number = 0;
    private expectedKeepaliveTimeoutMs: number = 30 * 1000;
    private watchdogInterval: NodeJS.Timeout | null = null;
    private degradedSinceAt: number | null = null;
    private watchdogExitScheduled: boolean = false;
    private isShuttingDown: boolean = false;
    private streamsApiGate = new ApiBackoffGate(STREAMS_API_MIN_INTERVAL_MS, STREAMS_API_MAX_BACKOFF_MS);
    private announcementsApiGate = new ApiBackoffGate(0, ANNOUNCEMENTS_API_MAX_BACKOFF_MS);
    private twitchApi: TwitchApiClient | null = null;
    private telegramMessageBuilder = new TelegramMessageBuilder();
    private lastStreamsSkipLogAt: number = 0;
    private lastAnnouncementsSkipLogAt: number = 0;

    constructor(telegram: Telegram) {
        this.telegramSender = new TelegramSender(telegram);
        this.announcementState = loadAnnouncementState();
        this.currentLinkIndex = this.announcementState.currentLinkIndex;
        console.log('📋 Загружено состояние announcements:', this.announcementState);

        process.once('SIGINT', () => this.handleShutdown('SIGINT'));
        process.once('SIGTERM', () => this.handleShutdown('SIGTERM'));
    }

    private async handleShutdown(signal: string) {
        this.isShuttingDown = true;
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
            this.twitchApi = new TwitchApiClient({
                accessToken: this.accessToken,
                clientId: this.clientId,
                streamsGate: this.streamsApiGate,
                announcementsGate: this.announcementsApiGate
            });

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
            this.startOfflineProbeLoop();
            this.startWatchdog();

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
                this.lastEventSubMessageAt = Date.now();
            });

            this.ws.on('message', async (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    await this.handleMessage(message);

                    if (message.metadata?.message_type === 'session_welcome') {
                        resolve();
                    }
                } catch (error) {
                    const rawText = data?.toString ? data.toString() : String(data);
                    log('ERROR', {
                        context: 'TwitchEventSubNative.MessageParse',
                        error: error instanceof Error ? error.message : String(error),
                        rawPreview: rawText.length > 1200 ? `${rawText.slice(0, 1200)}...` : rawText
                    });
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

    private buildEventSubRawEntry(message: any): Record<string, any> {
        const metadata = message?.metadata ?? {};
        const payload = message?.payload ?? {};
        const session = payload?.session ?? {};
        const subscription = payload?.subscription ?? {};
        const event = payload?.event ?? null;

        let rawBytes = 0;
        let eventPreview = '';
        try {
            const raw = JSON.stringify(message);
            rawBytes = Buffer.byteLength(raw, 'utf8');
        } catch {
            // ignore
        }

        if (event && typeof event === 'object') {
            try {
                const eventStr = JSON.stringify(event);
                eventPreview = eventStr.length > 800 ? `${eventStr.slice(0, 800)}...` : eventStr;
            } catch {
                eventPreview = '[unserializable event payload]';
            }
        }

        return {
            messageType: metadata.message_type ?? null,
            messageId: metadata.message_id ?? null,
            messageTimestamp: metadata.message_timestamp ?? null,
            subscriptionType: subscription.type ?? null,
            sessionId: session.id ?? null,
            reconnectUrl: session.reconnect_url ?? null,
            rawBytes,
            eventPreview
        };
    }

    private async handleMessage(message: any): Promise<void> {
        const messageType = message.metadata?.message_type;
        this.lastEventSubMessageAt = Date.now();

        if (messageType !== 'session_keepalive') {
            log('EVENTSUB_RAW', this.buildEventSubRawEntry(message));
        }

        switch (messageType) {
            case 'session_welcome':
                this.lastKeepaliveAt = Date.now();
                await this.handleSessionWelcome(message);
                break;

            case 'session_keepalive':
                this.lastKeepaliveAt = Date.now();
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
        this.expectedKeepaliveTimeoutMs = Math.max(keepaliveTimeout, 5) * 1000;

        this.startKeepAliveMonitor(keepaliveTimeout);

        // Подписки привязаны к session_id. При новом session_id их нужно создавать заново,
        // иначе Twitch закрывает соединение как "connection unused".
        if (!this.sessionId) {
            console.warn('⚠️ session_id пустой — пропускаем создание подписок');
        } else if (this.subscriptionsSessionId !== this.sessionId) {
            this.subscriptionsCreated = false;
            await this.subscribeToEvents();
            this.subscriptionsCreated = true;
            this.subscriptionsSessionId = this.sessionId;
        } else {
            console.log('ℹ️ Подписки уже созданы для текущей сессии, пропускаем');
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

    private startWatchdog(): void {
        if (this.watchdogInterval) return;
        this.watchdogInterval = setInterval(() => this.checkWatchdog(), WATCHDOG_CHECK_INTERVAL_MS);
    }

    private stopWatchdog(): void {
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }
        this.degradedSinceAt = null;
        this.watchdogExitScheduled = false;
    }

    private checkWatchdog(): void {
        if (this.isShuttingDown) return;

        const now = Date.now();
        const issues: string[] = [];

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            issues.push('websocket_not_open');
        }
        if (this.lastEventSubMessageAt > 0 && now - this.lastEventSubMessageAt > EVENTSUB_SILENCE_TIMEOUT_MS) {
            issues.push(`eventsub_silence>${Math.floor((now - this.lastEventSubMessageAt) / 1000)}s`);
        }
        if (this.lastKeepaliveAt > 0 && now - this.lastKeepaliveAt > this.expectedKeepaliveTimeoutMs * 3) {
            issues.push(`keepalive_stale>${Math.floor((now - this.lastKeepaliveAt) / 1000)}s`);
        }

        if (issues.length === 0) {
            if (this.degradedSinceAt) {
                const degradedForSec = Math.floor((now - this.degradedSinceAt) / 1000);
                console.log(`✅ Watchdog: состояние восстановлено (degraded ${degradedForSec}s)`);
                log('CONNECTION', {
                    service: 'TwitchEventSubNative',
                    status: 'recovered',
                    degradedForSec
                });
            }
            this.degradedSinceAt = null;
            this.watchdogExitScheduled = false;
            return;
        }

        if (!this.degradedSinceAt) {
            this.degradedSinceAt = now;
            console.warn(`⚠️ Watchdog: деградация EventSub (${issues.join(', ')})`);
            log('CONNECTION', {
                service: 'TwitchEventSubNative',
                status: 'degraded',
                issues
            });
            return;
        }

        const degradedMs = now - this.degradedSinceAt;
        if (degradedMs < WATCHDOG_DEGRADED_GRACE_MS || this.watchdogExitScheduled) {
            return;
        }

        this.watchdogExitScheduled = true;
        const degradedSec = Math.floor(degradedMs / 1000);
        console.error(`💥 Watchdog: деградация держится ${degradedSec}s, завершаем процесс для автоперезапуска PM2`);
        log('ERROR', {
            context: 'TwitchEventSubNative.watchdog',
            error: 'Degraded too long, process exit for PM2 recovery',
            degradedSec,
            issues
        });

        setTimeout(() => process.exit(1), 1500);
    }

    private async subscribeToEvents(): Promise<void> {
        console.log('📝 Подписываемся на события...');

        await this.subscribe('stream.online', { broadcaster_user_id: this.broadcasterId });
        await this.subscribe('stream.offline', { broadcaster_user_id: this.broadcasterId });
        await this.subscribe('channel.raid', { to_broadcaster_user_id: this.broadcasterId });
        
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
            console.log('   • channel.raid');
            console.log('   • channel.follow');
        } catch (error: any) {
            console.warn('⚠️ Не удалось подписаться на channel.follow (возможно нет scope: moderator:read:followers)');
            console.warn(`   Причина: ${error.message}`);
            console.log('📋 Подписки EventSub зарегистрированы:');
            console.log('   • stream.online');
            console.log('   • stream.offline');
            console.log('   • channel.raid');
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

            case 'channel.raid':
                await this.handleRaid(event);
                break;

            default:
                console.log('❓ Неизвестное событие:', eventType);
        }
    }

    private async handleStreamOnline(event: TwitchEventSubStreamOnlineEvent): Promise<void> {
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

    private async handleStreamOffline(event: TwitchEventSubStreamOfflineEvent): Promise<void> {
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
            this.triggerOfflineRecoveryProbe('event:channel.follow');
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

    private async handleRaid(event: any): Promise<void> {
        const fromName = event.from_broadcaster_user_name || event.from_broadcaster_user_login || 'Кто-то';
        const viewers = event.viewers ?? 0;
        console.log(`⚔️ Входящий рейд: ${fromName} с ${viewers} зрителями`);
        this.triggerOfflineRecoveryProbe('event:channel.raid');

        if (!ENABLE_BOT_FEATURES) {
            console.log('🔇 Сообщение при рейде отключено (ENABLE_BOT_FEATURES=false)');
            return;
        }

        const { ALLOW_LOCAL_COMMANDS } = require('../config/features');
        if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) {
            console.log('🔒 Локально сообщения при рейде заблокированы');
            return;
        }

        const template = this.getRaidMessage ? await this.getRaidMessage() : '';
        if (template && this.chatSender && this.channelName) {
            const message = template
                .replace(/\{from\}/gi, fromName)
                .replace(/\{viewers\}/gi, String(viewers));
            try {
                await this.chatSender(this.channelName, message);
                console.log(`✅ Отправлено сообщение при рейде: ${message.slice(0, 50)}...`);
            } catch (error) {
                console.error('❌ Ошибка отправки сообщения при рейде:', error);
            }
        } else if (!template) {
            console.log('ℹ️ Сообщение при рейде не настроено');
        }

        if (this.broadcastAccessToken && this.broadcasterId && this.clientId) {
            try {
                const toBroadcasterId = event.from_broadcaster_user_id;
                if (!toBroadcasterId) {
                    console.warn('⚠️ Нет from_broadcaster_user_id в событии рейда');
                    return;
                }
                const url = new URL('https://api.twitch.tv/helix/chat/shoutouts');
                url.searchParams.set('from_broadcaster_id', this.broadcasterId);
                url.searchParams.set('to_broadcaster_id', toBroadcasterId);
                url.searchParams.set('moderator_id', this.broadcasterId);

                const res = await fetch(url.toString(), {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.broadcastAccessToken}`,
                        'Client-Id': this.clientId,
                    },
                });

                if (res.ok) {
                    console.log(`✅ Авто-шатаут отправлен: ${fromName}`);
                } else {
                    const errText = await res.text();
                    console.warn(`⚠️ Ошибка авто-шатаута (${res.status}):`, errText);
                }
            } catch (error: any) {
                console.error('❌ Ошибка отправки авто-шатаута:', error?.message || error);
            }
        } else {
            if (!this.broadcastAccessToken) {
                console.log('ℹ️ Авто-шатаут пропущен: нет BROADCAST_TWITCH_ACCESS_TOKEN');
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

    private startOfflineProbeLoop(): void {
        if (this.offlineProbeInterval) {
            clearInterval(this.offlineProbeInterval);
        }
        this.offlineProbeInterval = setInterval(() => {
            void this.triggerOfflineRecoveryProbe('timer:offline-poll');
        }, OFFLINE_STATUS_POLL_MS);
    }

    private stopOfflineProbeLoop(): void {
        if (this.offlineProbeInterval) {
            clearInterval(this.offlineProbeInterval);
            this.offlineProbeInterval = null;
        }
    }

    private async triggerOfflineRecoveryProbe(reason: string): Promise<void> {
        if (this.isStreamOnline || this.statusProbeInFlight) return;
        const now = Date.now();
        if (
            reason.startsWith('event:') &&
            now - this.lastOfflineEventProbeAt < OFFLINE_EVENT_TRIGGER_PROBE_COOLDOWN_MS
        ) {
            return;
        }
        if (reason.startsWith('event:')) {
            this.lastOfflineEventProbeAt = now;
        }
        await this.checkCurrentStreamStatus(reason);
    }

    private handleApiResult<T>(
        result: ApiCallResult<T>,
        options: {
            context: string;
            api: 'streams' | 'announcements';
        }
    ): 'ok' | 'skip' | 'failed' {
        const apiMeta = this.API_META[options.api];
        const throttle = this.getSkipThrottleRef(options.api);
        return handleApiResultPolicy(result, {
            context: options.context,
            apiMeta,
            lastSkipAt: throttle.get(),
            setLastSkipAt: throttle.set,
            skipLogThrottleMs: SKIP_LOG_THROTTLE_MS,
            log
        });
    }

    private getSkipThrottleRef(api: 'streams' | 'announcements'): {
        get: () => number;
        set: (value: number) => void;
    } {
        return api === 'streams'
            ? {
                get: () => this.lastStreamsSkipLogAt,
                set: (value: number) => { this.lastStreamsSkipLogAt = value; }
            }
            : {
                get: () => this.lastAnnouncementsSkipLogAt,
                set: (value: number) => { this.lastAnnouncementsSkipLogAt = value; }
            };
    }

    private async checkCurrentStreamStatus(reason: string = 'startup'): Promise<void> {
        if (this.statusProbeInFlight) return;
        this.statusProbeInFlight = true;
        try {
            if (!this.twitchApi) {
                log('ERROR', {
                    context: 'TwitchEventSubNative.streamsApi',
                    error: 'TwitchApiClient not initialized',
                    reason: `probe:${reason}`
                });
                return;
            }
            const streamResult = await this.twitchApi.getStreamByUserId(this.broadcasterId, `probe:${reason}`);
            const status = this.handleApiResult(streamResult, {
                context: `probe:${reason}`,
                api: 'streams'
            });
            if (status !== 'ok') {
                return;
            }
            if (isApiOk(streamResult) && streamResult.data) {
                if (streamResult.recovered) {
                    log('CONNECTION', {
                        service: 'TwitchEventSubNative.streamsApi',
                        status: 'recovered',
                        reason: `probe:${reason}`,
                        failureCount: streamResult.failureCountBeforeRecover ?? 0
                    });
                }
                const stream = streamResult.data;
                console.error(`📊 Статус стрима: 🟢 В ЭФИРЕ`);
                console.error(`   🎮 Игра: ${stream.game_name || 'Не указана'}`);
                console.error(`   📝 Название: ${stream.title}`);
                console.error(`   👥 Зрителей: ${stream.viewer_count}`);

                const wasOffline = !this.isStreamOnline;
                this.isStreamOnline = true;
                log('STREAM_STATUS_PROBE', {
                    reason,
                    online: true,
                    viewers: stream.viewer_count,
                    title: stream.title,
                    startedAt: stream.started_at,
                });
                if (wasOffline) {
                    log('STREAM_ONLINE_RECOVERED', {
                        channel: stream.user_name || this.broadcasterName,
                        reason,
                        startedAt: stream.started_at,
                    });
                }

                try {
                    this.onStreamOnlineCallback?.();
                    console.log('✅ Синхронизация зрителей запущена (стрим уже онлайн)');
                } catch (e) {
                    console.error('❌ Ошибка при запуске синхронизации зрителей:', e);
                }

                this.startWelcomeMessageInterval();
                this.startLinkRotation();

                const startDate = new Date(stream.started_at);
                this.startViewerCountTracking(this.broadcasterId, this.broadcasterName, startDate);
            } else {
                console.error(`📊 Статус стрима: 🔴 Оффлайн`);
                log('STREAM_STATUS_PROBE', { reason, online: false });
            }
        } catch (error) {
            console.error('⚠️ Не удалось получить статус стрима:', error);
            log('ERROR', {
                context: 'TwitchEventSubNative.checkCurrentStreamStatus',
                error: error instanceof Error ? error.message : String(error),
                reason,
            });
        } finally {
            this.statusProbeInFlight = false;
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

    private stopViewerCountTracking(): StreamTrackingResult | null {
        if (!this.currentStreamStats || this.currentStreamStats.viewerCounts.length === 0) {
            this.currentStreamStats = null;
            return null;
        }

        const stats = computeStreamStats({
            viewerCounts: this.currentStreamStats.viewerCounts,
            followsCount: this.currentStreamStats.followsCount,
            startTimeMs: this.currentStreamStats.startTime.getTime()
        });
        const broadcasterName = this.currentStreamStats.broadcasterName;
        const startTime = this.currentStreamStats.startTime;
        const duration = formatDuration(stats.durationMs);

        console.error('\n📊 ===== СТАТИСТИКА СТРИМА =====');
        console.error(`👤 Канал: ${broadcasterName}`);
        console.error(`⏱️  Длительность: ${duration}`);
        console.error(`👥 Пик зрителей: ${stats.peak}`);
        console.error(`💜 Новых follow: ${stats.followsCount}`);
        console.error('================================\n');

        this.currentStreamStats = null;

        return {
            stats: { ...stats, duration, startTime },
            broadcasterName
        };
    }

    public async recordViewersNow(chattersCount?: number): Promise<void> {
        if (!this.isStreamOnline || !this.currentStreamStats) {
            return;
        }

        try {
            if (!this.twitchApi) return;
            const streamResult = await this.twitchApi.getStreamByUserId(
                this.currentStreamStats.broadcasterId,
                'viewers:record'
            );
            const status = this.handleApiResult(streamResult, {
                context: 'viewers:record',
                api: 'streams'
            });
            if (status !== 'ok') {
                return;
            }
            if (!isApiOk(streamResult) || !streamResult.data) return;
            if (streamResult.recovered) {
                log('CONNECTION', {
                    service: 'TwitchEventSubNative.streamsApi',
                    status: 'recovered',
                    reason: 'viewers:record',
                    failureCount: streamResult.failureCountBeforeRecover ?? 0
                });
            }

            const viewersAPI = streamResult.data.viewer_count;
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
        } catch (error) {
            console.error('⚠️ Ошибка синхронизированного замера viewers:', error);
        }
    }

    private async sendTelegramStreamNotification(event: TwitchEventSubStreamOnlineEvent): Promise<void> {
        if (!this.telegramChannelId) return;

        try {
            if (!this.twitchApi) return;
            const streamResult = await this.twitchApi.getStreamByUserId(
                event.broadcaster_user_id,
                'telegram:stream_notification'
            );
            const status = this.handleApiResult(streamResult, {
                context: 'telegram:stream_notification',
                api: 'streams'
            });
            if (status !== 'ok') {
                return;
            }

            let streamData: { game_name?: string | null; title: string } | null = null;
            if (isApiOk(streamResult) && streamResult.data) {
                if (streamResult.recovered) {
                    log('CONNECTION', {
                        service: 'TwitchEventSubNative.streamsApi',
                        status: 'recovered',
                        reason: 'telegram:stream_notification',
                        failureCount: streamResult.failureCountBeforeRecover ?? 0
                    });
                }
                streamData = streamResult.data;
            }
            const message = this.telegramMessageBuilder.buildStreamOnlineMessage({ event, stream: streamData });

            await this.telegramSender.sendMessage(this.telegramChannelId, message, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: false }
            });

            console.error('✅ Уведомление о начале стрима отправлено в Telegram');
        } catch (error) {
            console.error('❌ Ошибка при отправке уведомления:', error);
        }
    }

    private async sendTelegramOfflineNotification(
        event: TwitchEventSubStreamOfflineEvent,
        result: StreamTrackingResult
    ): Promise<void> {
        if (!this.telegramChatId) return;

        try {
            const { stats } = result;
            const message = this.telegramMessageBuilder.buildStreamOfflineMessage({ event, stats });

            await this.telegramSender.sendMessage(this.telegramChatId, message, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true }
            });

            console.error('✅ Уведомление об окончании стрима отправлено в Telegram');

            const adminChatId = process.env.BACKUP_ADMIN_ID;
            if (adminChatId) {
                console.log('📦 Создание бэкапа БД после окончания стрима...');
                const { exec } = require('child_process');
                const backupScript = require('path').join(MONOREPO_ROOT, 'scripts', 'backup-db.js');
                exec(`node "${backupScript}" ${adminChatId}`, (error: Error | null, stdout: string) => {
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

    private async saveStreamHistory(result: StreamTrackingResult): Promise<void> {
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
        // При обычном запуске / переподключении не сбрасываем индекс — он хранится в файле
        // При полном рестарте (например, новый процесс) индекс уже восстановлен из состояния
        this.stopLinkRotation(false);
        if (!this.getLinkRotationItems || !this.getRotationIntervalMinutes) {
            console.log('🔄 Ротация ссылок: провайдер не задан, пропускаем');
            return;
        }

        void (async () => {
            try {
                const [items, intervalMinutes] = await Promise.all([
                    this.getLinkRotationItems!(),
                    this.getRotationIntervalMinutes!(),
                ]);
                if (items.length === 0) {
                    console.log('🔄 Ротация ссылок: нет команд с флагом «в ротации», не запускаем');
                    return;
                }
                const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
                console.log(`🔄 Ротация ссылок: ${items.length} шт., первая через ${intervalMinutes} мин, затем каждые ${intervalMinutes} мин`);

                this.linkRotationTimeout = setTimeout(() => {
                    void this.sendNextLinkAnnouncement();
                    this.linkRotationInterval = setInterval(() => {
                        void this.sendNextLinkAnnouncement();
                    }, intervalMs);
                }, intervalMs);
            } catch (e) {
                console.error('❌ Ошибка запуска ротации ссылок:', e);
            }
        })();
    }

    setLinkRotationProvider(
        getItems: () => Promise<LinkRotationItem[]>,
        getIntervalMinutes: () => Promise<number>
    ): void {
        this.getLinkRotationItems = getItems;
        this.getRotationIntervalMinutes = getIntervalMinutes;
    }

    private stopLinkRotation(resetIndex: boolean = true): void {
        if (this.linkRotationTimeout) {
            clearTimeout(this.linkRotationTimeout);
            this.linkRotationTimeout = null;
        }

        if (this.linkRotationInterval) {
            clearInterval(this.linkRotationInterval);
            this.linkRotationInterval = null;
            if (resetIndex) {
                this.currentLinkIndex = 0;
                this.announcementState.currentLinkIndex = 0;
                saveAnnouncementState(this.announcementState);
            }
        }
    }

    /**
     * Мягкий перезапуск ротации ссылок при изменении интервала во время стрима.
     * Останавливает таймеры, но не сбрасывает текущий индекс — ротация продолжается с текущего места.
     */
    public reloadLinkRotation(): void {
        if (!this.isStreamOnline) {
            // Если стрим оффлайн — ничего не делаем, ротация стартует при следующем онлайне
            return;
        }
        this.stopLinkRotation(false);
        this.startLinkRotation(false);
    }

    private async sendNextLinkAnnouncement(): Promise<void> {
        if (!this.isStreamOnline) return;
        if (!ENABLE_BOT_FEATURES) return;

        const { ALLOW_LOCAL_COMMANDS } = require('../config/features');
        if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) return;

        if (!this.accessToken || !this.clientId || !this.broadcasterId || !this.moderatorId) return;
        if (!this.getLinkRotationItems) return;

        const items = await this.getLinkRotationItems();
        if (items.length === 0) return;

        this.currentLinkIndex = this.currentLinkIndex % items.length;
        const currentLink = items[this.currentLinkIndex];

        try {
            console.log(`📣 Ротация ссылок [${this.currentLinkIndex + 1}/${items.length}]: ${currentLink.message.split(':')[0]}`);
            if (!this.twitchApi) {
                log('ERROR', {
                    context: 'TwitchEventSubNative.announcementsApi',
                    error: 'TwitchApiClient not initialized',
                    reason: 'links-rotation'
                });
                return;
            }
            const result = await this.twitchApi.sendAnnouncement({
                broadcasterId: this.broadcasterId,
                moderatorId: this.moderatorId,
                message: currentLink.message,
                color: currentLink.color,
                context: 'links-rotation'
            });
            const status = this.handleApiResult(result, {
                context: 'links-rotation',
                api: 'announcements'
            });
            if (status !== 'ok') {
                return;
            }
            if (isApiOk(result)) {
                if (result.recovered) {
                    log('CONNECTION', {
                        service: 'TwitchEventSubNative.announcementsApi',
                        status: 'recovered',
                        failureCount: result.failureCountBeforeRecover ?? 0
                    });
                }
            }

            console.log(`✅ Link announcement отправлен (цвет: ${currentLink.color})`);

            this.currentLinkIndex = (this.currentLinkIndex + 1) % items.length;
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
    }

    setRaidMessageProvider(provider: () => Promise<string>): void {
        this.getRaidMessage = provider;
    }

    setBroadcastAccessToken(token: string): void {
        this.broadcastAccessToken = token?.trim() || null;
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
            this.isShuttingDown = true;
            this.isStreamOnline = false;
            this.stopWelcomeMessageInterval();
            // При явном отключении (рестарт бота) не сбрасываем индекс ротации,
            // чтобы при быстром перезапуске во время стрима продолжить с того же места
            this.stopLinkRotation(false);

            if (this.keepAliveInterval) {
                clearInterval(this.keepAliveInterval);
                this.keepAliveInterval = null;
            }
            this.stopOfflineProbeLoop();
            this.stopWatchdog();

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
