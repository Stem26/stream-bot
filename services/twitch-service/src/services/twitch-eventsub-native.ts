/**
 * Нативная реализация Twitch EventSub WebSocket (без Twurple)
 * Решает проблему с 429 ошибками и множественными транспортами
 */

import WebSocket from 'ws';
import type { Telegram } from 'telegraf';
import { ALLOW_LOCAL_COMMANDS, ENABLE_BOT_FEATURES } from '../config/features';
import { IS_LOCAL } from '../config/env';
import { addStreamToHistory } from '../storage/stream-history';
import { log } from '../utils/event-logger';
import * as fs from 'fs';
import * as path from 'path';
import { ApiBackoffGate, TwitchApiClient } from './twitch/twitch-api-client';
import { API_SKIP_EVENTS, handleApiResult as handleApiResultPolicy } from './twitch/twitch-api-policy';
import {
    buildEventSubRawEntry,
    createEventSubSubscription,
    deleteWebsocketSubscriptionsForOurChannelTypes,
    getEventSubParseMetrics,
    resetEventSubParseMetrics,
    parseEventSubNotification
} from './twitch/twitch-eventsub-transport';
import type {
    TwitchEventSubFollowEvent,
    TwitchEventSubRaidEvent,
    TwitchEventSubStreamOfflineEvent,
    TwitchEventSubStreamOnlineEvent
} from './twitch/twitch-eventsub.types';
import { computeStreamStats, formatDuration } from './twitch/stream-tracker';
import { TelegramMessageBuilder, TelegramSender } from './twitch/telegram';
import { isApiOk, type ApiCallResult } from './twitch/twitch-api.types';
import {
    assertEventSubSubscribeBatchSession,
    computeEventSubWatchdogIssues,
    shouldSendTelegramStreamOnlineForStartedAt,
    shouldSkipEventSubSubscribeCooldown,
    streamStartedAtToMs
} from './twitch/eventsub-regression-guards';

function resolveMonorepoRoot(): string {
    // PM2 может запускать процесс из services/twitch-service (там тоже есть package.json),
    // поэтому ищем именно корень монорепы: package.json + папка services/.
    let dir = process.cwd();
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'services'))) {
            return dir;
        }
        const parent = path.resolve(dir, '..');
        if (parent === dir) break;
        dir = parent;
    }
    return process.cwd();
}

const MONOREPO_ROOT = resolveMonorepoRoot();

const ANNOUNCEMENT_STATE_FILE = path.join(MONOREPO_ROOT, 'announcement-state.json');

interface AnnouncementState {
    lastWelcomeAnnouncementAt: number | null;
    lastLinkAnnouncementAt: number | null;
    currentLinkIndex: number;
    currentStreamPeak: number | null;
    currentStreamStartTime: number | null;
    currentStreamFollowsCount: number | null;
    lastNotifiedStreamStartedAt: number | null;
}

function loadAnnouncementState(): AnnouncementState {
    const defaultState: AnnouncementState = {
        lastWelcomeAnnouncementAt: null,
        lastLinkAnnouncementAt: null,
        currentLinkIndex: 0,
        currentStreamPeak: null,
        currentStreamStartTime: null,
        currentStreamFollowsCount: null,
        lastNotifiedStreamStartedAt: null
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

let saveAnnouncementStateTimer: NodeJS.Timeout | null = null;
let pendingSaveState: AnnouncementState | null = null;

function saveAnnouncementState(state: AnnouncementState): void {
    pendingSaveState = state;
    
    if (saveAnnouncementStateTimer !== null) {
        return;
    }
    
    saveAnnouncementStateTimer = setTimeout(() => {
        saveAnnouncementStateTimer = null;
        if (pendingSaveState === null) {
            return;
        }
        const stateToSave = pendingSaveState;
        pendingSaveState = null;
        
        setImmediate(() => {
            try {
                fs.writeFileSync(ANNOUNCEMENT_STATE_FILE, JSON.stringify(stateToSave, null, 2));
            } catch (error) {
                console.error('⚠️ Ошибка сохранения состояния announcements:', error);
            }
        });
    }, 500);
}

// Fallback welcome-текст: используется только если links_config.all_links_text пустой.
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
const STREAMS_API_MIN_INTERVAL_MS = 10 * 1000;
const STREAMS_API_MAX_BACKOFF_MS = 5 * 60 * 1000;
const ANNOUNCEMENTS_API_MAX_BACKOFF_MS = 2 * 60 * 1000;
const SKIP_LOG_THROTTLE_MS = 30_000;
/** Ожидание session_welcome после открытия WebSocket. */
const EVENTSUB_WELCOME_TIMEOUT_MS = 30_000;
/** Не дергать reconnect из keepalive чаще (защита от шторма при лагах). */
const KEEPALIVE_RECONNECT_DEBOUNCE_MS = 5_000;
/** Потолок задержки между попытками reconnect (экспоненциальный backoff). */
const EVENTSUB_RECONNECT_DELAY_CAP_MS = 30_000;
/** Случайный разброс к задержке reconnect (мс), чтобы инстансы не били API синхронно. */
const EVENTSUB_RECONNECT_JITTER_MAX_MS = 1000;
/** Логируем, если subscribeToEvents длится дольше (мс); флаг subscribeInFlight снимается только в finally. */
const EVENTSUB_SUBSCRIBE_INFLIGHT_GUARD_MS = 15_000;
/** Слияние повторных handleDisconnect(socket_close) (двойной close / гонка). */
const HANDLE_DISCONNECT_SOCKET_COALESCE_MS = 400;
/** Минимум между полными subscribeToEvents для одной и той же session_id (анти-429 при reconnect-шторме). */
const EVENTSUB_SUBSCRIBE_COOLDOWN_MS = 10_000;

/** Кто инициировал handleDisconnect('keepalive') — для логов (watchdog vs интервал монитора). */
type EventSubKeepaliveDisconnectTrigger = 'watchdog' | 'keepalive_monitor';

function envTrue(value: string | undefined): boolean {
    if (!value) return false;
    return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

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
    private isInitialStartup: boolean = true;
    /**
     * Статус стрима на момент старта процесса (по первому probe через Helix).
     * Нужен, чтобы не подавлять TG-уведомление о реальном старте стрима после запуска бота,
     * но при этом продолжать подавлять уведомление при старте бота в середине уже идущего стрима.
     */
    private startupStreamStatus: 'online' | 'offline' | 'unknown' = 'unknown';
    private currentStreamStats: StreamStats | null = null;
    private announcementState: AnnouncementState;

    private welcomeInterval: NodeJS.Timeout | null = null;
    private welcomeTimeout: ReturnType<typeof setTimeout> | null = null;
    private linkRotationInterval: NodeJS.Timeout | null = null;
    private linkRotationTimeout: NodeJS.Timeout | null = null;
    private currentLinkIndex: number = 0;

    private chatSender: ((channel: string, message: string) => Promise<void>) | null = null;
    private channelName: string = '';

    private onStreamOfflineCallback: (() => void) | null = null;
    private onStreamOnlineCallback: (() => void) | null = null;

    private getLinkRotationItems: (() => Promise<LinkRotationItem[]>) | null = null;
    private getRotationIntervalMinutes: (() => Promise<number>) | null = null;
    private getWelcomeMessage: (() => Promise<string>) | null = null;
    private getRaidMessage: (() => Promise<string>) | null = null;
    /** Рейд-буст дуэлей: логин рейдера (как в EventSub) + число зрителей рейда */
    private onRaidDuelBoost: ((raiderLogin: string, viewers: number) => void) | null = null;
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
    /** Только `notification` — для диагностики; watchdog не использует для kill. */
    private lastEventSubNotificationAt: number = 0;
    private lastKeepaliveAt: number = 0;
    private expectedKeepaliveTimeoutMs: number = 30 * 1000;
    private watchdogInterval: NodeJS.Timeout | null = null;
    private degradedSinceAt: number | null = null;
    /** Когда watchdog в этом эпизоде деградации уже дернул мягкий reconnect (трассировка / отладка). */
    private watchdogReconnectTriggeredAt: number | null = null;
    private watchdogExitScheduled: boolean = false;
    private isShuttingDown: boolean = false;

    /** Жизненный цикл сокета EventSub: защита от параллельных connect и лишних подписок. */
    private connectionState: 'idle' | 'connecting' | 'connected' = 'idle';
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private reconnectScheduled = false;
    /** Пока идём на URL из session_reconnect — не планируем параллельный connect на основной endpoint. */
    private isUsingReconnectUrl = false;
    private subscribeInFlight = false;
    private lastKeepaliveReconnectAt = 0;
    /** Таймаут session_welcome только для ветки handleReconnect (основной connect — свой таймер в Promise). */
    private reconnectWelcomeTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSocketCloseDisconnectScheduleAt = 0;
    private lastSubscribeAt = 0;
    private lastSubscribeCooldownSessionId: string | null = null;

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

    private async gracefulExit(reason: string): Promise<void> {
        console.error(`❌ Критическая ошибка: ${reason} — выполняем graceful shutdown для PM2`);
        try {
            await Promise.race([
                this.disconnect(),
                new Promise(resolve => setTimeout(resolve, 3000))
            ]);
        } catch (error) {
            console.error('⚠️ Ошибка при graceful shutdown:', error);
        }
        process.exit(1);
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

    private clearReconnectTimeout(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
    }

    private clearReconnectWelcomeTimer(): void {
        if (this.reconnectWelcomeTimer) {
            clearTimeout(this.reconnectWelcomeTimer);
            this.reconnectWelcomeTimer = null;
        }
    }

    /** Снять обработчики и закрыть сокет (не трогать другой инстанс, уже назначенный в this.ws). */
    private teardownWebSocket(ws: WebSocket | null): void {
        if (!ws) {
            return;
        }
        try {
            ws.removeAllListeners();
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        } catch {
            /* ignore */
        }
    }

    private async connectWebSocket(): Promise<void> {
        if (this.isShuttingDown) {
            throw new Error('EventSub: shutdown');
        }
        if (this.connectionState === 'connecting') {
            console.log('⏭️ EventSub: уже идёт подключение — пропуск дублирующего connectWebSocket');
            return;
        }
        if (
            this.connectionState === 'connected'
            && this.ws
            && this.ws.readyState === WebSocket.OPEN
        ) {
            console.log('⏭️ EventSub: соединение уже активно');
            return;
        }

        this.connectionState = 'connecting';
        this.clearReconnectTimeout();
        this.clearReconnectWelcomeTimer();

        const previousWs = this.ws;
        this.teardownWebSocket(previousWs);
        this.ws = null;

        return new Promise((resolve, reject) => {
            let settled = false;
            let welcomeTimer: ReturnType<typeof setTimeout>;
            let sock: WebSocket;

            const succeed = () => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(welcomeTimer);
                resolve();
            };

            const fail = (err: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(welcomeTimer);
                this.connectionState = 'idle';
                if (this.ws === sock) {
                    this.ws = null;
                }
                this.teardownWebSocket(sock);
                reject(err);
            };

            console.log('🔌 Подключаемся к Twitch EventSub WebSocket...');
            sock = new WebSocket('wss://eventsub.wss.twitch.tv/ws');
            this.ws = sock;

            welcomeTimer = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                this.connectionState = 'idle';
                if (this.ws === sock) {
                    this.ws = null;
                }
                this.teardownWebSocket(sock);
                reject(new Error('WebSocket connection timeout'));
            }, EVENTSUB_WELCOME_TIMEOUT_MS);

            sock.on('open', () => {
                console.log('✅ WebSocket соединение установлено');
                log('EVENTSUB_WEBSOCKET', { status: 'connected' });
                this.lastKeepaliveStatus = 'active';
                this.lastEventSubMessageAt = Date.now();
            });

            sock.on('message', async (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    await this.handleMessage(message);

                    if (message.metadata?.message_type === 'session_welcome') {
                        succeed();
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

            sock.on('error', (error) => {
                console.error('❌ WebSocket ошибка:', error);
                log('ERROR', {
                    context: 'TwitchEventSubNative.WebSocket',
                    error: error.message
                });
                this.lastKeepaliveStatus = 'error';
                fail(error instanceof Error ? error : new Error(String(error)));
            });

            sock.on('close', (code, reason) => {
                if (this.ws !== sock) {
                    console.log('⏭️ EventSub: close устаревшего сокета — игнор');
                    return;
                }
                console.log(`⚫ WebSocket закрыт: ${code} ${reason.toString()}`);
                log('EVENTSUB_WEBSOCKET', {
                    status: 'closed',
                    code,
                    reason: reason.toString()
                });
                this.lastKeepaliveStatus = null;
                this.connectionState = 'idle';
                if (!settled) {
                    fail(new Error(`closed before welcome: ${code} ${reason.toString()}`));
                }
                this.handleDisconnect('socket_close');
            });
        });
    }

    private async handleMessage(message: any): Promise<void> {
        const messageType = message.metadata?.message_type;
        // Для watchdog «тишины» не считаем welcome/keepalive — иначе после одного welcome таймер «активности» сбрасывается.
        if (messageType !== 'session_keepalive' && messageType !== 'session_welcome') {
            this.lastEventSubMessageAt = Date.now();
        }

        if (messageType !== 'session_keepalive') {
            log('EVENTSUB_RAW', buildEventSubRawEntry(message));
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
                this.lastEventSubNotificationAt = Date.now();
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
        this.clearReconnectWelcomeTimer();
        this.reconnectAttempts = 0;
        this.subscribeInFlight = false;

        this.sessionId = message.payload.session.id;
        const keepaliveTimeout = message.payload.session.keepalive_timeout_seconds;

        console.log(`✅ Session ID получен: ${this.sessionId}`);
        console.log(`⏱️  Keepalive timeout: ${keepaliveTimeout}s`);
        this.expectedKeepaliveTimeoutMs = Math.max(keepaliveTimeout, 5) * 1000;

        this.startKeepAliveMonitor(keepaliveTimeout);

        try {
            // Подписки привязаны к session_id. При новом session_id их нужно создавать заново,
            // иначе Twitch закрывает соединение как "connection unused".
            if (!this.sessionId) {
                console.warn('⚠️ session_id пустой — пропускаем создание подписок');
            } else if (this.subscriptionsSessionId !== this.sessionId) {
                if (this.subscribeInFlight) {
                    console.log('⏭️ Подписки EventSub уже создаются — пропуск параллельного вызова');
                } else {
                    this.subscriptionsCreated = false;
                    this.subscribeInFlight = true;
                    const flightGuard = setTimeout(() => {
                        if (this.subscribeInFlight) {
                            console.warn(
                                '⚠️ subscribeToEvents: нет завершения дольше ' +
                                    `${EVENTSUB_SUBSCRIBE_INFLIGHT_GUARD_MS / 1000}s (ждём finally, флаг не сбрасываем)`
                            );
                        }
                    }, EVENTSUB_SUBSCRIBE_INFLIGHT_GUARD_MS);
                    try {
                        const applied = await this.subscribeToEvents();
                        if (applied) {
                            this.subscriptionsCreated = true;
                            this.subscriptionsSessionId = this.sessionId;
                        }
                    } finally {
                        clearTimeout(flightGuard);
                        this.subscribeInFlight = false;
                    }
                }
            } else {
                console.log('ℹ️ Подписки уже созданы для текущей сессии, пропускаем');
            }

            await this.checkCurrentStreamStatus();
            this.connectionState = 'connected';
        } finally {
            this.isUsingReconnectUrl = false;
        }
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
                if (this.connectionState !== 'connected') {
                    return;
                }
                // Логируем только появление ошибки
                if (this.lastKeepaliveStatus !== 'error') {
                    console.error('⚠️ WebSocket не активен, требуется переподключение');
                    log('EVENTSUB_KEEPALIVE', { status: 'error', message: 'WebSocket not active' });
                    this.lastKeepaliveStatus = 'error';
                }
                this.handleDisconnect('keepalive', 'keepalive_monitor');
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
        this.watchdogReconnectTriggeredAt = null;
        this.watchdogExitScheduled = false;
    }

    private checkWatchdog(): void {
        if (this.isShuttingDown) return;

        const now = Date.now();
        const wsSocketOpen = Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
        const issues = computeEventSubWatchdogIssues({
            now,
            connectionState: this.connectionState,
            wsSocketOpen,
            lastKeepaliveAt: this.lastKeepaliveAt,
            lastEventSubMessageAt: this.lastEventSubMessageAt,
            expectedKeepaliveTimeoutMs: this.expectedKeepaliveTimeoutMs
        });

        if (issues.length === 0) {
            if (this.degradedSinceAt) {
                const degradedForSec = Math.floor((now - this.degradedSinceAt) / 1000);
                const watchdogHadReconnectNudge = this.watchdogReconnectTriggeredAt !== null;
                console.log(`✅ Watchdog: состояние восстановлено (degraded ${degradedForSec}s)`);
                log('CONNECTION', {
                    service: 'TwitchEventSubNative',
                    status: 'recovered',
                    degradedForSec,
                    watchdogHadReconnectNudge
                });
            }
            this.degradedSinceAt = null;
            this.watchdogReconnectTriggeredAt = null;
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
            // «Тихо умершее» соединение может оставаться OPEN — сразу пробуем reconnect, не ждём только grace + kill.
            if (this.connectionState === 'connected') {
                this.watchdogReconnectTriggeredAt = now;
                console.log('🔧 Watchdog: мягкий reconnect (keepalive) при первой деградации');
                this.handleDisconnect('keepalive', 'watchdog');
            }
            return;
        }

        const degradedMs = now - this.degradedSinceAt;
        if (degradedMs < WATCHDOG_DEGRADED_GRACE_MS || this.watchdogExitScheduled) {
            return;
        }

        this.watchdogExitScheduled = true;
        const degradedSec = Math.floor(degradedMs / 1000);
        log('ERROR', {
            context: 'TwitchEventSubNative.watchdog',
            error: 'Degraded too long, process exit for PM2 recovery',
            degradedSec,
            issues
        });

        void this.gracefulExit(`Watchdog: деградация держится ${degradedSec}s`);
    }

    private assertSubscribeBatchSession(batchSessionId: string): void {
        assertEventSubSubscribeBatchSession(this.sessionId, batchSessionId);
    }

    /** @returns true если подписки созданы; false при cooldown (повтор для той же session_id слишком рано). */
    private async subscribeToEvents(): Promise<boolean> {
        console.log('📝 Подписываемся на события...');

        const batchSessionId = this.sessionId;
        if (!batchSessionId) {
            throw new Error('EventSub: нет sessionId для подписок');
        }

        if (this.subscriptionsSessionId !== batchSessionId) {
            console.log(`🔄 Session ID изменился (${this.subscriptionsSessionId} → ${batchSessionId}) — сброс subscriptionsCreated`);
            this.subscriptionsCreated = false;
            this.subscriptionsSessionId = batchSessionId;
        }

        const now = Date.now();
        if (
            shouldSkipEventSubSubscribeCooldown({
                now,
                batchSessionId,
                lastSubscribeAt: this.lastSubscribeAt,
                lastSubscribeCooldownSessionId: this.lastSubscribeCooldownSessionId,
                cooldownMs: EVENTSUB_SUBSCRIBE_COOLDOWN_MS
            })
        ) {
            console.warn(
                `⏭️ subscribeToEvents: cooldown ${EVENTSUB_SUBSCRIBE_COOLDOWN_MS / 1000}s для этой session_id — пропуск`
            );
            return false;
        }

        this.assertSubscribeBatchSession(batchSessionId);

        try {
            const cleanup = await deleteWebsocketSubscriptionsForOurChannelTypes({
                accessToken: this.accessToken,
                clientId: this.clientId,
                broadcasterId: this.broadcasterId
            });
            this.assertSubscribeBatchSession(batchSessionId);
            if (cleanup.deleted > 0 || cleanup.failed > 0) {
                console.log(
                    `🧹 EventSub: перед подпиской удалено ${cleanup.deleted} старых websocket-подписок (ошибок DELETE: ${cleanup.failed})`
                );
            }
        } catch (e) {
            console.warn(
                '⚠️ Предочистка websocket-подписок EventSub пропущена:',
                e instanceof Error ? e.message : e
            );
        }

        this.assertSubscribeBatchSession(batchSessionId);

        try {
            await this.subscribe('stream.online', { broadcaster_user_id: this.broadcasterId });
            this.assertSubscribeBatchSession(batchSessionId);
            await this.subscribe('stream.offline', { broadcaster_user_id: this.broadcasterId });
            this.assertSubscribeBatchSession(batchSessionId);
            await this.subscribe('channel.raid', { to_broadcaster_user_id: this.broadcasterId });
            this.assertSubscribeBatchSession(batchSessionId);
        } catch (e) {
            console.warn(
                '⚠️ Частично созданные подписки EventSub возможны после ошибки; повтор может дублировать типы на сессии (при 429 см. eventsub:cleanup)'
            );
            throw e;
        }

        // channel.follow требует scope: moderator:read:followers
        // Если токен не имеет этого scope, подписка будет пропущена
        try {
            this.assertSubscribeBatchSession(batchSessionId);
            await this.subscribe('channel.follow', {
                broadcaster_user_id: this.broadcasterId,
                moderator_user_id: this.moderatorId
            });
            this.assertSubscribeBatchSession(batchSessionId);
            console.log('📋 Подписки EventSub зарегистрированы:');
            console.log('   • stream.online');
            console.log('   • stream.offline');
            console.log('   • channel.raid');
            console.log('   • channel.follow');
        } catch (error: any) {
            if (error instanceof Error && error.message === 'EventSub: session_id changed during subscribe batch') {
                throw error;
            }
            console.warn('⚠️ Не удалось подписаться на channel.follow (возможно нет scope: moderator:read:followers)');
            console.warn(`   Причина: ${error.message}`);
            console.log('📋 Подписки EventSub зарегистрированы:');
            console.log('   • stream.online');
            console.log('   • stream.offline');
            console.log('   • channel.raid');
        }

        // Cooldown только после полного успеха: throw / return false выше не обновляют эти поля.
        this.lastSubscribeAt = Date.now();
        this.lastSubscribeCooldownSessionId = batchSessionId;
        return true;
    }

    private async subscribe(type: string, condition: any): Promise<void> {
        const sessionAtStart = this.sessionId;
        try {
            await createEventSubSubscription({
                accessToken: this.accessToken,
                clientId: this.clientId,
                sessionId: sessionAtStart,
                type,
                condition
            });

            if (this.sessionId !== sessionAtStart) {
                console.warn(
                    `⚠️ Подписка ${type} относится к устаревшей session_id (смена сессии во время запроса) — результат игнорируем`
                );
                return;
            }

            console.log(`✅ Подписка на ${type} создана`);
        } catch (error: any) {
            console.error(`❌ Ошибка подписки на ${type}:`, error.message);
            throw error;
        }
    }

    /** Стабильный маркер эфира: время из Twitch started_at (ISO), не Date.now(). */
    private streamStartedAtToUnixMs(startedAt: string | undefined | null): number {
        if (startedAt == null || startedAt === '') {
            return Date.now();
        }
        const t = new Date(startedAt).getTime();
        return Number.isFinite(t) ? t : Date.now();
    }

    private async handleNotification(message: any): Promise<void> {
        const payload = parseEventSubNotification(message);
        if (!payload) {
            return;
        }
        const eventType = payload.type;

        console.log(`📨 Событие: ${eventType}`);
        log('EVENTSUB_NOTIFICATION', { type: eventType });

        switch (payload.type) {
            case 'stream.online':
                await this.handleStreamOnline(payload.event);
                break;

            case 'stream.offline':
                await this.handleStreamOffline(payload.event);
                break;

            case 'channel.follow':
                await this.handleFollow(payload.event);
                break;

            case 'channel.raid':
                await this.handleRaid(payload.event);
                break;

            default: {
                const _exhaustive: never = payload;
                return _exhaustive;
            }
        }
    }

    private async handleStreamOnline(event: TwitchEventSubStreamOnlineEvent): Promise<void> {
        const startedAtMs = this.streamStartedAtToUnixMs(event.started_at);

        if (this.isStreamOnline) {
            const cur = this.announcementState.currentStreamStartTime;
            if (cur === startedAtMs) {
                log('STREAM_ONLINE_DEDUP', {
                    channel: event.broadcaster_user_name,
                    startedAtMs
                });
                return;
            }
            this.announcementState.currentStreamStartTime = startedAtMs;
            saveAnnouncementState(this.announcementState);
            if (cur != null) {
                console.warn(
                    `⚠️ stream.online при уже онлайн: маркер стрима ${cur} -> ${startedAtMs} (started_at Twitch)`
                );
            } else {
                console.warn(
                    `⚠️ Стрим уже онлайн, currentStreamStartTime был пуст — записали started_at: ${startedAtMs}`
                );
            }
            return;
        }

        try {
            this.onStreamOnlineCallback?.();
            console.log('✅ Синхронизация зрителей запущена при начале стрима');
        } catch (e) {
            console.error('❌ Ошибка при запуске синхронизации зрителей:', e);
        }

        console.error(`🔴 Стрим начался на канале ${event.broadcaster_user_name}!`);
        this.isStreamOnline = true;

        this.announcementState.currentStreamPeak = null;
        this.announcementState.currentStreamStartTime = startedAtMs;
        saveAnnouncementState(this.announcementState);

        log('STREAM_ONLINE', { channel: event.broadcaster_user_name, startedAtMs });

        await this.sendWelcomeMessage();
        this.startWelcomeMessageInterval();
        this.startLinkRotation(true);

        if (this.telegramChannelId) {
            const forceStartupTelegram = envTrue(process.env.TELEGRAM_FORCE_STREAM_ONLINE_ON_STARTUP);
            // Если это первый запуск и EventSub прислал stream.online для уже идущего стрима - не отправляем уведомление
            if (this.isInitialStartup && this.startupStreamStatus === 'online' && !forceStartupTelegram) {
                console.error(
                    '⏭️ Стрим уже онлайн при старте бота — уведомление в Telegram не отправляем (initial startup, eventsub)'
                );
                log('TELEGRAM_STREAM_ONLINE_SKIPPED_INITIAL_STARTUP', {
                    source: 'eventsub',
                    broadcasterUserId: event.broadcaster_user_id,
                    startedAt: event.started_at,
                });
                this.markTelegramStreamStartNotified(event.started_at);
            } else if (
                forceStartupTelegram
                && this.isInitialStartup
                && this.startupStreamStatus === 'online'
            ) {
                console.warn('📣 Форсируем TG-уведомление о старте (startup online, eventsub)');
                log('TELEGRAM_STREAM_ONLINE_FORCED_ON_STARTUP' as any, {
                    source: 'eventsub',
                    broadcasterUserId: event.broadcaster_user_id,
                    startedAt: event.started_at,
                });
                await this.sendTelegramStreamNotification(event);
            } else if (this.shouldSendTelegramStreamStartForStartedAt(event.started_at)) {
                await this.sendTelegramStreamNotification(event);
            } else {
                console.error('⏭️ Уведомление о старте стрима в Telegram уже отправляли для этого started_at — пропуск');
                log('TELEGRAM_STREAM_ONLINE_SKIPPED_DUPLICATE', {
                    source: 'eventsub',
                    broadcasterUserId: event.broadcaster_user_id,
                    startedAt: event.started_at,
                });
            }
        } else {
            console.warn(
                '⚠️ Telegram уведомление о старте стрима пропущено: не задан CHANNEL_ID (telegram.channelId)'
            );
            log('TELEGRAM_STREAM_ONLINE_SKIPPED_NO_CHANNEL_ID', {
                source: 'eventsub',
                broadcasterUserId: event.broadcaster_user_id,
                broadcasterUserLogin: event.broadcaster_user_login,
                broadcasterUserName: event.broadcaster_user_name,
                startedAt: event.started_at,
            });
        }
        
        // Сбрасываем флаг первого запуска после обработки stream.online
        if (this.isInitialStartup) {
            this.isInitialStartup = false;
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
        } else {
            this.announcementState.lastNotifiedStreamStartedAt = null;
            saveAnnouncementState(this.announcementState);
        }
    }

    private async handleFollow(event: TwitchEventSubFollowEvent): Promise<void> {
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

        if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) {
            console.log('🔒 Локально благодарности за Follow заблокированы');
            return;
        }

        if (this.chatSender && this.channelName) {
            try {
                await this.chatSender(this.channelName, `@${event.user_name} спасибо за follow❤️`);
                console.log(`✅ Отправлена благодарность за Follow: @${event.user_name}`);
            } catch (error) {
                console.error('❌ Ошибка отправки благодарности за Follow:', error);
            }
        }
    }

    private async handleRaid(event: TwitchEventSubRaidEvent): Promise<void> {
        const fromName = event.from_broadcaster_user_name || event.from_broadcaster_user_login || 'Кто-то';
        const viewers = event.viewers ?? 0;
        console.log(`⚔️ Входящий рейд: ${fromName} с ${viewers} зрителями`);
        this.triggerOfflineRecoveryProbe('event:channel.raid');

        if (!ENABLE_BOT_FEATURES) {
            console.log('🔇 Сообщение при рейде отключено (ENABLE_BOT_FEATURES=false)');
            return;
        }

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

        const raiderLogin = event.from_broadcaster_user_login?.trim();
        // Буст дуэлей только пока эфир онлайн; при оффлайне не пишем в БД/память
        if (this.isStreamOnline && raiderLogin && this.onRaidDuelBoost) {
            try {
                this.onRaidDuelBoost(raiderLogin.toLowerCase(), event.viewers ?? 0);
            } catch (e) {
                console.error('❌ Ошибка onRaidDuelBoost:', e);
            }
        }
    }

    private async handleReconnect(reconnectUrl: string): Promise<void> {
        console.log('🔄 Переподключение к новому WebSocket...');

        this.clearReconnectTimeout();
        this.clearReconnectWelcomeTimer();
        this.subscribeInFlight = false;
        this.isUsingReconnectUrl = true;
        this.connectionState = 'connecting';

        const previousWs = this.ws;
        this.teardownWebSocket(previousWs);
        this.ws = null;

        const sock = new WebSocket(reconnectUrl);
        this.ws = sock;

        this.reconnectWelcomeTimer = setTimeout(() => {
            if (this.isShuttingDown) {
                return;
            }
            if (this.ws !== sock) {
                return;
            }
            console.error(
                `❌ EventSub reconnect: нет session_welcome за ${EVENTSUB_WELCOME_TIMEOUT_MS / 1000}s — закрываем сокет`
            );
            this.clearReconnectWelcomeTimer();
            this.isUsingReconnectUrl = false;
            this.connectionState = 'idle';
            this.teardownWebSocket(sock);
            if (this.ws === sock) {
                this.ws = null;
            }
            this.handleDisconnect('socket_close');
        }, EVENTSUB_WELCOME_TIMEOUT_MS);

        sock.on('open', () => {
            console.log('✅ Переподключение успешно');
            log('EVENTSUB_WEBSOCKET', { status: 'reconnected' });
            this.lastKeepaliveStatus = 'active';
            this.lastEventSubMessageAt = Date.now();
        });

        sock.on('message', async (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());
                await this.handleMessage(message);
            } catch (error) {
                console.error('❌ Ошибка обработки сообщения:', error);
            }
        });

        sock.on('error', (error) => {
            console.error('❌ WebSocket ошибка:', error);
            log('ERROR', {
                context: 'TwitchEventSubNative.Reconnect',
                error: error.message
            });
            this.lastKeepaliveStatus = 'error';
        });

        sock.on('close', (code, reason) => {
            if (this.ws !== sock) {
                console.log('⏭️ EventSub reconnect: close устаревшего сокета — игнор');
                return;
            }
            this.clearReconnectWelcomeTimer();
            console.log(`⚫ WebSocket закрыт: ${code} ${reason.toString()}`);
            log('EVENTSUB_WEBSOCKET', {
                status: 'closed_after_reconnect',
                code,
                reason: reason.toString()
            });
            this.lastKeepaliveStatus = null;
            this.isUsingReconnectUrl = false;
            this.connectionState = 'idle';
            this.handleDisconnect('socket_close');
        });
    }

    private handleDisconnect(
        source: 'socket_close' | 'keepalive' = 'socket_close',
        keepaliveTrigger?: EventSubKeepaliveDisconnectTrigger
    ): void {
        if (this.isShuttingDown) {
            return;
        }

        // Нельзя требовать connectionState === 'connected': после close мы уже в idle, иначе reconnect никогда не запланируется.

        if (this.isUsingReconnectUrl) {
            console.log('⏭️ EventSub: идёт переход на reconnect_url — не планируем параллельный reconnect');
            return;
        }

        if (this.connectionState === 'connecting') {
            console.log('⏭️ EventSub: уже идёт connectWebSocket — пропуск лишнего handleDisconnect');
            return;
        }

        if (source === 'socket_close') {
            const coalesceNow = Date.now();
            if (
                coalesceNow - this.lastSocketCloseDisconnectScheduleAt
                < HANDLE_DISCONNECT_SOCKET_COALESCE_MS
            ) {
                console.log('⏭️ EventSub: coalesce повторного handleDisconnect(socket_close)');
                return;
            }
            this.lastSocketCloseDisconnectScheduleAt = coalesceNow;
        }

        if (this.reconnectTimeout !== null || this.reconnectScheduled) {
            console.log('⏭️ EventSub: reconnect уже запланирован — пропуск handleDisconnect');
            return;
        }

        this.reconnectScheduled = true;

        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }

        if (source === 'keepalive') {
            if (this.connectionState !== 'connected') {
                return;
            }
            const now = Date.now();
            if (now - this.lastKeepaliveReconnectAt < KEEPALIVE_RECONNECT_DEBOUNCE_MS) {
                const from = keepaliveTrigger ?? 'keepalive';
                console.log(
                    `⏭️ EventSub keepalive: debounce reconnect — пропуск (вызов от ${from})`
                );
                return;
            }
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            log('ERROR', {
                context: 'TwitchEventSubNative.handleDisconnect',
                error: 'Max reconnect attempts exceeded, process exit for PM2 recovery'
            });
            if (!this.watchdogExitScheduled) {
                this.watchdogExitScheduled = true;
                this.reconnectScheduled = false;
                void this.gracefulExit('Превышено максимальное количество попыток переподключения');
            }
            return;
        }

        this.reconnectAttempts++;
        const baseDelay = Math.min(
            EVENTSUB_RECONNECT_DELAY_CAP_MS,
            this.reconnectDelay * 2 ** (this.reconnectAttempts - 1)
        );
        const jitterMs = Math.floor(
            Math.random() * EVENTSUB_RECONNECT_JITTER_MAX_MS * this.reconnectAttempts
        );
        const delay = baseDelay + jitterMs;

        if (source === 'keepalive') {
            this.lastKeepaliveReconnectAt = Date.now();
        }

        const triggerSuffix =
            source === 'keepalive' && keepaliveTrigger ? ` [${keepaliveTrigger}]` : '';
        console.log(
            `🔄 Попытка переподключения ${this.reconnectAttempts}/${this.maxReconnectAttempts} через ${delay}ms (base ${baseDelay}+jitter ${jitterMs})${triggerSuffix}`
        );
        log('EVENTSUB_RECONNECT', {
            attempt: this.reconnectAttempts,
            maxAttempts: this.maxReconnectAttempts,
            delayMs: delay,
            baseDelayMs: baseDelay,
            jitterMs,
            source,
            ...(keepaliveTrigger ? { keepaliveTrigger } : {})
        });

        this.reconnectTimeout = setTimeout(async () => {
            this.reconnectTimeout = null;
            this.reconnectScheduled = false;
            if (this.connectionState === 'connecting' || this.isUsingReconnectUrl) {
                console.log(
                    '⏭️ EventSub: таймер reconnect отменён — уже идёт connectWebSocket или session_reconnect'
                );
                return;
            }
            try {
                await this.connectWebSocket();
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
                if (reason === 'startup') {
                    this.startupStreamStatus = 'online';
                }
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
                // Идентификатор эфира = started_at из Helix (как в EventSub), не Date.now().
                const startedAtMs = this.streamStartedAtToUnixMs(stream.started_at);
                const curStart = this.announcementState.currentStreamStartTime;
                if (curStart !== startedAtMs) {
                    this.announcementState.currentStreamStartTime = startedAtMs;
                    saveAnnouncementState(this.announcementState);
                    if (curStart != null) {
                        console.warn(
                            `📝 currentStreamStartTime выровнен по streams API started_at: ${startedAtMs} (было ${curStart})`
                        );
                    } else {
                        console.warn(`📝 currentStreamStartTime записан из streams API: ${startedAtMs}`);
                    }
                }

                // Если EventSub не прислал stream.online (или мы стартовали в середине стрима),
                // отправляем Telegram-уведомление о старте при первом обнаружении "онлайн" через polling.
                if (wasOffline) {
                    const pseudoEvent: TwitchEventSubStreamOnlineEvent = {
                        broadcaster_user_id: this.broadcasterId,
                        broadcaster_user_login: (stream.user_login ?? stream.user_name ?? this.broadcasterName ?? '').toLowerCase(),
                        broadcaster_user_name: stream.user_name || this.broadcasterName,
                        started_at: stream.started_at,
                    };
                    if (this.telegramChannelId) {
                        const forceStartupTelegram = envTrue(process.env.TELEGRAM_FORCE_STREAM_ONLINE_ON_STARTUP);
                        // При первом запуске бота не отправляем уведомление, если стрим уже идет
                        if (this.isInitialStartup && this.startupStreamStatus === 'online' && !forceStartupTelegram) {
                            console.error(
                                '⏭️ Стрим уже онлайн при старте бота — уведомление в Telegram не отправляем (initial startup)'
                            );
                            log('TELEGRAM_STREAM_ONLINE_SKIPPED_INITIAL_STARTUP', {
                                source: 'polling',
                                broadcasterUserId: pseudoEvent.broadcaster_user_id,
                                startedAt: pseudoEvent.started_at,
                                reason,
                            });
                            // Сохраняем started_at, чтобы не отправлять уведомление при последующих проверках
                            this.markTelegramStreamStartNotified(stream.started_at);
                        } else if (
                            forceStartupTelegram
                            && this.isInitialStartup
                            && this.startupStreamStatus === 'online'
                        ) {
                            console.warn('📣 Форсируем TG-уведомление о старте (startup online, polling)');
                            log('TELEGRAM_STREAM_ONLINE_FORCED_ON_STARTUP' as any, {
                                source: 'polling',
                                broadcasterUserId: pseudoEvent.broadcaster_user_id,
                                startedAt: pseudoEvent.started_at,
                                reason,
                            });
                            await this.sendTelegramStreamNotification(pseudoEvent);
                        } else if (this.shouldSendTelegramStreamStartForStartedAt(stream.started_at)) {
                            await this.sendTelegramStreamNotification(pseudoEvent);
                        } else {
                            console.error(
                                '⏭️ Уведомление о старте стрима в Telegram уже отправляли для этого started_at — пропуск (polling)'
                            );
                            log('TELEGRAM_STREAM_ONLINE_SKIPPED_DUPLICATE', {
                                source: 'polling',
                                broadcasterUserId: pseudoEvent.broadcaster_user_id,
                                startedAt: pseudoEvent.started_at,
                                reason,
                            });
                        }
                    } else {
                        console.warn(
                            '⚠️ Telegram уведомление о старте стрима пропущено: не задан CHANNEL_ID (telegram.channelId)'
                        );
                        log('TELEGRAM_STREAM_ONLINE_SKIPPED_NO_CHANNEL_ID', {
                            source: 'polling',
                            broadcasterUserId: pseudoEvent.broadcaster_user_id,
                            broadcasterUserLogin: pseudoEvent.broadcaster_user_login,
                            broadcasterUserName: pseudoEvent.broadcaster_user_name,
                            startedAt: pseudoEvent.started_at,
                        });
                    }
                }
                this.startViewerCountTracking(this.broadcasterId, this.broadcasterName, startDate);
            } else {
                if (reason === 'startup') {
                    this.startupStreamStatus = 'offline';
                }
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
            // Важно: не держим isInitialStartup=true бесконечно при сбоях Helix,
            // иначе первый реальный stream.online после старта процесса будет ошибочно подавлен.
            if (reason === 'startup' && this.isInitialStartup) {
                this.isInitialStartup = false;
            }
            this.statusProbeInFlight = false;
        }
    }

    private startViewerCountTracking(broadcasterId: string, broadcasterName: string, startDate: Date): void {
        const startMs = startDate.getTime();
        if (!Number.isFinite(startMs)) {
            console.warn('⚠️ startViewerCountTracking: невалидный started_at, пропуск');
            return;
        }
        if (this.currentStreamStats?.startTime.getTime() === startMs) {
            console.error('ℹ️ Отслеживание зрителей уже для этого started_at — пропуск');
            return;
        }
        if (this.currentStreamStats) {
            const prev = this.currentStreamStats;
            console.warn('⚠️ Viewer tracking reset due to new started_at', {
                prevStart: prev.startTime.toISOString(),
                newStart: startDate.toISOString()
            });
            this.currentStreamStats = null;
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

    /** Не дублировать TG при recovery/polling для того же эфира (одинаковый `started_at` у Twitch). */
    private shouldSendTelegramStreamStartForStartedAt(startedAt: string): boolean {
        return shouldSendTelegramStreamOnlineForStartedAt(
            this.announcementState.lastNotifiedStreamStartedAt,
            startedAt
        );
    }

    private markTelegramStreamStartNotified(startedAt: string): void {
        const ms = streamStartedAtToMs(startedAt);
        if (ms === null) {
            return;
        }
        this.announcementState.lastNotifiedStreamStartedAt = ms;
        saveAnnouncementState(this.announcementState);
    }

    private async sendTelegramStreamNotification(event: TwitchEventSubStreamOnlineEvent): Promise<void> {
        if (!this.telegramChannelId) return;

        try {
            let streamData: { game_name?: string | null; title: string } | null = null;
            if (this.twitchApi) {
                // Пытаемся получить данные стрима с retry (до 3 попыток с задержкой)
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const streamResult = await this.twitchApi.getStreamByUserId(
                        event.broadcaster_user_id,
                        `telegram:stream_notification:attempt${attempt}`
                    );
                    const status = this.handleApiResult(streamResult, {
                        context: `telegram:stream_notification:attempt${attempt}`,
                        api: 'streams'
                    });
                    if (status === 'ok' && isApiOk(streamResult) && streamResult.data) {
                        if (streamResult.recovered) {
                            log('CONNECTION', {
                                service: 'TwitchEventSubNative.streamsApi',
                                status: 'recovered',
                                reason: `telegram:stream_notification:attempt${attempt}`,
                                failureCount: streamResult.failureCountBeforeRecover ?? 0
                            });
                        }
                        streamData = streamResult.data;
                        if (attempt > 1) {
                            console.log(`✅ Данные стрима получены с попытки ${attempt}`);
                        }
                        break;
                    } else if (attempt < 3) {
                        // Ждем 2 секунды перед следующей попыткой
                        console.warn(`⚠️ Попытка ${attempt}/3 получить данные стрима не удалась, повтор через 2с...`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    } else {
                        // Последняя попытка не удалась - отправляем без данных
                        console.warn('⚠️ Не удалось получить данные стрима после 3 попыток — отправляем упрощенное уведомление');
                        streamData = null;
                    }
                }
            }
            const message = this.telegramMessageBuilder.buildStreamOnlineMessage({ event, stream: streamData });

            // Пытаемся отправить уведомление с retry (до 3 попыток)
            let lastError: Error | null = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await this.telegramSender.sendMessage(this.telegramChannelId, message, {
                        parse_mode: 'HTML',
                        link_preview_options: { is_disabled: false }
                    });

                    this.markTelegramStreamStartNotified(event.started_at);

                    console.error('✅ Уведомление о начале стрима отправлено в Telegram');
                    if (attempt > 1) {
                        console.log(`   (успешно с попытки ${attempt}/3)`);
                    }
                    
                    log('TELEGRAM_STREAM_ONLINE_SENT', {
                        broadcasterUserId: event.broadcaster_user_id,
                        broadcasterUserLogin: event.broadcaster_user_login,
                        broadcasterUserName: event.broadcaster_user_name,
                        startedAt: event.started_at,
                        telegramChannelId: this.telegramChannelId,
                        streamsApi: streamData ? 'ok' : 'skip_or_failed',
                        attempt
                    });
                    return; // Успешно отправлено
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                    
                    if (attempt < 3) {
                        const delay = attempt * 2000; // 2с, 4с
                        console.warn(`⚠️ Попытка ${attempt}/3 отправить уведомление о начале стрима не удалась`);
                        console.warn(`   Причина: ${lastError.message}`);
                        console.warn(`   Повтор через ${delay/1000}с...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }
            
            // Все 3 попытки не удались
            throw lastError || new Error('Failed to send stream notification after 3 attempts');
        } catch (error) {
            console.error('❌ Ошибка при отправке уведомления:', error);
            log('TELEGRAM_STREAM_ONLINE_FAILED', {
                broadcasterUserId: event.broadcaster_user_id,
                broadcasterUserLogin: event.broadcaster_user_login,
                broadcasterUserName: event.broadcaster_user_name,
                startedAt: event.started_at,
                telegramChannelId: this.telegramChannelId,
                error: error instanceof Error ? error.message : String(error),
                errorType: (error as any).code || 'UNKNOWN'
            });
        }
    }

    private async sendTelegramOfflineNotification(
        event: TwitchEventSubStreamOfflineEvent,
        result: StreamTrackingResult
    ): Promise<void> {
        if (!this.telegramChatId) return;

        const { stats } = result;
        const message = this.telegramMessageBuilder.buildStreamOfflineMessage({ event, stats });

        // Пытаемся отправить до 3 раз с задержкой
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await this.telegramSender.sendMessage(this.telegramChatId, message, {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true }
                });

                console.error('✅ Уведомление об окончании стрима отправлено в Telegram');
                if (attempt > 1) {
                    console.log(`   (успешно с попытки ${attempt}/3)`);
                }

                log('TELEGRAM_STREAM_OFFLINE_SENT' as any, {
                    broadcasterUserId: event.broadcaster_user_id,
                    broadcasterUserName: event.broadcaster_user_name,
                    telegramChatId: this.telegramChatId,
                    attempt,
                    stats: {
                        duration: stats.duration,
                        peak: stats.peak,
                        followsCount: stats.followsCount
                    }
                });

                // Успех - создаём бэкап и выходим
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
                return; // Успешно отправлено
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                
                if (attempt < 3) {
                    const delay = attempt * 2000; // 2с, 4с
                    console.warn(`⚠️ Попытка ${attempt}/3 отправить уведомление об окончании не удалась`);
                    console.warn(`   Причина: ${lastError.message}`);
                    console.warn(`   Повтор через ${delay/1000}с...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    // Последняя попытка не удалась
                    console.error('❌ Ошибка при отправке уведомления об окончании:', lastError);
                    log('TELEGRAM_STREAM_OFFLINE_FAILED' as any, {
                        broadcasterUserId: event.broadcaster_user_id,
                        broadcasterUserName: event.broadcaster_user_name,
                        telegramChatId: this.telegramChatId,
                        attempts: 3,
                        error: lastError.message,
                        errorType: (lastError as any).code || 'UNKNOWN',
                        stats: {
                            duration: stats.duration,
                            peak: stats.peak,
                            followsCount: stats.followsCount
                        }
                    });
                }
            }
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
            this.announcementState.lastNotifiedStreamStartedAt = null;
            saveAnnouncementState(this.announcementState);
            console.log('🔄 Статистика текущего стрима сброшена (стрим завершён)');
        } catch (error) {
            console.error('❌ Ошибка при сохранении истории стрима:', error);
        }
    }

    private async sendWelcomeMessage(force: boolean = false): Promise<void> {
        if (!this.isStreamOnline) return;
        if (!ENABLE_BOT_FEATURES) return;

        if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) return;

        if (!this.chatSender || !this.channelName) return;

        const now = Date.now();
        const lastSent = this.announcementState.lastWelcomeAnnouncementAt;
        const timeSinceLastSent = lastSent ? now - lastSent : Infinity;

        if (!force && lastSent && timeSinceLastSent < ANNOUNCEMENT_REPEAT_INTERVAL_MS) {
            const remainingMins = Math.ceil(
                (ANNOUNCEMENT_REPEAT_INTERVAL_MS - timeSinceLastSent) / 60000
            );
            console.log(`⏳ Welcome сообщение пропущено: осталось ~${remainingMins} мин`);
            return;
        }

        try {
            const dbWelcomeMessage = this.getWelcomeMessage ? await this.getWelcomeMessage() : '';
            const welcomeMessage = (dbWelcomeMessage || '').trim() || STREAM_WELCOME_MESSAGE;
            await this.chatSender(this.channelName, welcomeMessage);
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

        this.welcomeTimeout = setTimeout(async () => {
            this.welcomeTimeout = null;
            await runMessage();
            this.welcomeInterval = setInterval(runMessage, ANNOUNCEMENT_REPEAT_INTERVAL_MS);
        }, initialDelay);
    }

    private stopWelcomeMessageInterval(): void {
        if (this.welcomeTimeout) {
            clearTimeout(this.welcomeTimeout);
            this.welcomeTimeout = null;
        }
        if (this.welcomeInterval) {
            clearInterval(this.welcomeInterval);
            this.welcomeInterval = null;
        }
    }

    private startLinkRotation(force: boolean = false): void {
        if (
            !force
            && (this.linkRotationInterval !== null || this.linkRotationTimeout !== null)
        ) {
            console.log('⏭️ Ротация ссылок уже активна — пропуск повторного startLinkRotation');
            return;
        }
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
                if (this.linkRotationTimeout) {
                    clearTimeout(this.linkRotationTimeout);
                    this.linkRotationTimeout = null;
                }
                if (this.linkRotationInterval) {
                    clearInterval(this.linkRotationInterval);
                    this.linkRotationInterval = null;
                }
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

    setWelcomeMessageProvider(provider: () => Promise<string>): void {
        this.getWelcomeMessage = provider;
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

    setRaidDuelBoostHandler(handler: ((raiderLogin: string, viewers: number) => void) | null): void {
        this.onRaidDuelBoost = handler;
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

    // Публичный accessor под будущий диагностический endpoint (/api/diagnostics/eventsub).
    // Может временно выглядеть "неиспользуемым", пока endpoint не подключен в web/server.ts.
    getEventSubParseMetrics(): { invalidPayload: number; unknownType: number } {
        return getEventSubParseMetrics();
    }

    // Технический reset для диагностических сценариев/ручных health-check тестов.
    // Аналогично: сейчас это задел под API и может не иметь прямых вызовов в runtime.
    resetEventSubParseMetrics(): void {
        resetEventSubParseMetrics();
    }

    async disconnect(): Promise<void> {
        try {
            this.isShuttingDown = true;
            this.isStreamOnline = false;
            this.clearReconnectTimeout();
            this.clearReconnectWelcomeTimer();
            this.connectionState = 'idle';
            this.isUsingReconnectUrl = false;
            this.subscribeInFlight = false;
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

            const w = this.ws;
            this.ws = null;
            this.teardownWebSocket(w);

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
