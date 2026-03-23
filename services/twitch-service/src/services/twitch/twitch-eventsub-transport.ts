import type {
    EventSubNotification,
    TwitchEventSubFollowEvent,
    TwitchEventSubRaidEvent,
    TwitchEventSubStreamOfflineEvent,
    TwitchEventSubStreamOnlineEvent
} from './twitch-eventsub.types';
import { log } from '../../utils/event-logger';

export type EventSubParseMetrics = {
    invalidPayload: number;
    unknownType: number;
};

const eventSubParseMetrics: EventSubParseMetrics = {
    invalidPayload: 0,
    unknownType: 0
};

export async function createEventSubSubscription(input: {
    accessToken: string;
    clientId: string;
    sessionId: string | null;
    type: string;
    condition: Record<string, string>;
}): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${input.accessToken}`,
                    'Client-Id': input.clientId,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    type: input.type,
                    version: input.type === 'channel.follow' ? '2' : '1',
                    condition: input.condition,
                    transport: {
                        method: 'websocket',
                        session_id: input.sessionId
                    }
                })
            });

            if (response.ok) {
                return;
            }

            const errorText = await response.text();
            const retryable = response.status === 429 || response.status >= 500;
            if (!retryable) {
                throw markAsNonRetryable(
                    new Error(`Ошибка подписки на ${input.type}: ${response.status} ${errorText}`)
                );
            }
            if (attempt === maxAttempts) {
                throw new Error(`Ошибка подписки на ${input.type}: ${response.status} ${errorText}`);
            }

            const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
            const backoffMs = retryAfterMs ?? (attempt * 700);
            await sleep(backoffMs);
            continue;
        } catch (error) {
            if (isNonRetryableError(error)) {
                throw error;
            }
            if (attempt === maxAttempts) {
                throw error;
            }
            await sleep(attempt * 700);
        }
    }
}

export type EventSubRawMessage = {
    metadata?: {
        message_type?: string;
        message_id?: string;
        message_timestamp?: string;
    };
    payload?: {
        session?: {
            id?: string;
            reconnect_url?: string;
        };
        subscription?: {
            type?: string;
        };
        event?: unknown;
    };
};

export interface EventSubRawLogEntry {
    messageType: string | null;
    messageId: string | null;
    messageTimestamp: string | null;
    subscriptionType: string | null;
    sessionId: string | null;
    reconnectUrl: string | null;
    rawBytes: number;
    eventPreview: string;
}

export function buildEventSubRawEntry(message: EventSubRawMessage): EventSubRawLogEntry {
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
        eventPreview = safePreview(event, 800);
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

export function parseEventSubNotification(message: EventSubRawMessage): EventSubNotification | null {
    const type = message.payload?.subscription?.type;
    const event = message.payload?.event;
    if (!type) {
        eventSubParseMetrics.unknownType += 1;
        log('WARN', {
            context: 'EventSub.parse.missing_type',
            eventPreview: safePreview({
                subscription: message.payload?.subscription,
                event: message.payload?.event
            }, 200)
        });
        return null;
    }

    if (!isObject(event)) {
        warnInvalid(type, event, 'EventSub.parse.invalid_event_shape');
        return null;
    }

    switch (type) {
        case 'stream.online':
            if (!isStreamOnlineEvent(event)) {
                warnInvalid(type, event);
                return null;
            }
            return { type: 'stream.online', event };
        case 'stream.offline':
            if (!isStreamOfflineEvent(event)) {
                warnInvalid(type, event);
                return null;
            }
            return { type: 'stream.offline', event };
        case 'channel.follow':
            if (!isFollowEvent(event)) {
                warnInvalid(type, event);
                return null;
            }
            return { type: 'channel.follow', event };
        case 'channel.raid':
            if (!isRaidEvent(event)) {
                warnInvalid(type, event);
                return null;
            }
            return { type: 'channel.raid', event };
        default:
            eventSubParseMetrics.unknownType += 1;
            log('WARN', {
                context: 'EventSub.parse.unknown_type',
                type,
                eventPreview: safePreview(event, 200)
            });
            return null;
    }
}

function isObject(e: unknown): e is Record<string, unknown> {
    return typeof e === 'object' && e !== null && !Array.isArray(e);
}

function hasString(obj: Record<string, unknown>, key: string): boolean {
    return typeof obj[key] === 'string';
}

function isStreamOnlineEvent(e: unknown): e is TwitchEventSubStreamOnlineEvent {
    if (!isObject(e)) return false;
    return hasString(e, 'broadcaster_user_id')
        && hasString(e, 'broadcaster_user_login')
        && hasString(e, 'broadcaster_user_name')
        && hasString(e, 'started_at');
}

function isStreamOfflineEvent(e: unknown): e is TwitchEventSubStreamOfflineEvent {
    if (!isObject(e)) return false;
    return hasString(e, 'broadcaster_user_id')
        && hasString(e, 'broadcaster_user_login')
        && hasString(e, 'broadcaster_user_name');
}

function isFollowEvent(e: unknown): e is TwitchEventSubFollowEvent {
    if (!isObject(e)) return false;
    return hasString(e, 'user_id')
        && hasString(e, 'user_login')
        && hasString(e, 'user_name');
}

function isRaidEvent(e: unknown): e is TwitchEventSubRaidEvent {
    if (!isObject(e)) return false;
    return hasString(e, 'from_broadcaster_user_id')
        && hasString(e, 'from_broadcaster_user_login')
        && hasString(e, 'from_broadcaster_user_name');
}

function warnInvalid(type: string, event: unknown, context = 'EventSub.parse.invalid_payload'): void {
    eventSubParseMetrics.invalidPayload += 1;
    log('WARN', {
        context,
        type,
        eventPreview: safePreview(event, 300)
    });
}

function safePreview(value: unknown, max = 300): string {
    try {
        const str = JSON.stringify(value);
        return str.length > max ? `${str.slice(0, max)}...` : str;
    } catch {
        return '[unserializable]';
    }
}

export function getEventSubParseMetrics(): EventSubParseMetrics {
    return { ...eventSubParseMetrics };
}

export function resetEventSubParseMetrics(): void {
    eventSubParseMetrics.invalidPayload = 0;
    eventSubParseMetrics.unknownType = 0;
}

function parseRetryAfterMs(value: string | null): number | null {
    if (!value) return null;
    const asSeconds = Number(value);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
        return asSeconds * 1000;
    }
    const asDateMs = Date.parse(value);
    if (Number.isFinite(asDateMs)) {
        return Math.max(0, asDateMs - Date.now());
    }
    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function markAsNonRetryable<T extends Error>(error: T): T & { nonRetryable: true } {
    (error as T & { nonRetryable: true }).nonRetryable = true;
    return error as T & { nonRetryable: true };
}

function isNonRetryableError(error: unknown): error is Error & { nonRetryable: true } {
    return typeof error === 'object'
        && error !== null
        && 'nonRetryable' in error
        && (error as { nonRetryable?: unknown }).nonRetryable === true;
}
