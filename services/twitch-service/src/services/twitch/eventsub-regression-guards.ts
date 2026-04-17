/**
 * Чистая логика инвариантов EventSub / Telegram (регрессии: watchdog, cooldown подписок, дедуп старта стрима).
 * Используется из TwitchEventSubNative и покрывается vitest без мока WebSocket.
 */

export type EventSubConnectionStateLite = 'idle' | 'connecting' | 'connected';

export function computeEventSubWatchdogIssues(params: {
    now: number;
    connectionState: EventSubConnectionStateLite;
    /** true, если сокет есть и readyState === OPEN (как у WebSocket в рантайме). */
    wsSocketOpen: boolean;
    lastKeepaliveAt: number;
    lastEventSubMessageAt: number;
    expectedKeepaliveTimeoutMs: number;
}): string[] {
    const {
        now,
        connectionState,
        wsSocketOpen,
        lastKeepaliveAt,
        lastEventSubMessageAt,
        expectedKeepaliveTimeoutMs
    } = params;

    const issues: string[] = [];
    const thrice = expectedKeepaliveTimeoutMs * 3;

    if (connectionState === 'connected' && !wsSocketOpen) {
        issues.push('websocket_not_open');
    }

    if (connectionState === 'connected') {
        const keepaliveStale =
            lastKeepaliveAt > 0 && now - lastKeepaliveAt > thrice;
        const noKeepaliveYetButSilent =
            lastKeepaliveAt === 0
            && lastEventSubMessageAt > 0
            && now - lastEventSubMessageAt > thrice;

        if (keepaliveStale) {
            issues.push(`keepalive_stale>${Math.floor((now - lastKeepaliveAt) / 1000)}s`);
        } else if (noKeepaliveYetButSilent) {
            issues.push(
                `eventsub_silent_no_keepalive>${Math.floor((now - lastEventSubMessageAt) / 1000)}s_since_msg`
            );
        }
    }

    return issues;
}

/** true — не запускать полный subscribeToEvents (cooldown для той же session_id). */
export function shouldSkipEventSubSubscribeCooldown(params: {
    now: number;
    batchSessionId: string;
    lastSubscribeAt: number;
    lastSubscribeCooldownSessionId: string | null;
    cooldownMs: number;
}): boolean {
    const {
        now,
        batchSessionId,
        lastSubscribeAt,
        lastSubscribeCooldownSessionId,
        cooldownMs
    } = params;
    return (
        lastSubscribeCooldownSessionId === batchSessionId
        && now - lastSubscribeAt < cooldownMs
    );
}

export function assertEventSubSubscribeBatchSession(
    currentSessionId: string | null,
    batchSessionId: string
): void {
    if (currentSessionId !== batchSessionId) {
        throw new Error('EventSub: session_id changed during subscribe batch');
    }
}

export function streamStartedAtToMs(startedAt: string): number | null {
    const ms = Date.parse(startedAt);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Разрешить отправку TG «стрим онлайн» для данного started_at (не дублировать один эфир).
 */
export function shouldSendTelegramStreamOnlineForStartedAt(
    lastNotifiedStreamStartedAt: number | null,
    startedAt: string
): boolean {
    const ms = streamStartedAtToMs(startedAt);
    if (ms === null) {
        return true;
    }
    return lastNotifiedStreamStartedAt !== ms;
}

export type StartupStreamStatus = 'online' | 'offline' | 'unknown';

export type TelegramStreamOnlineDecision =
    | { action: 'skip_initial_startup'; reason: 'startup_stream_online' }
    | { action: 'skip_duplicate'; reason: 'same_started_at' }
    | { action: 'send'; mode: 'normal' | 'forced_startup' };

export type LastKnownStreamState = {
    status: 'online' | 'offline';
    /** started_at в ms для последнего онлайна; null если неизвестно/оффлайн. */
    startedAtMs: number | null;
};

/**
 * Единое решение для TG «стрим онлайн».
 *
 * Инвариант:
 * - Уведомление отправляем только при реальном переходе в онлайн,
 *   а при старте процесса в середине уже идущего стрима — по умолчанию НЕ отправляем.
 * - При рестарте во время уже идущего стрима можно форсировать отправку (env-флаг).
 * - Дедуп — по started_at (один эфир = одно уведомление).
 */
export function decideTelegramStreamOnline(params: {
    isInitialStartup: boolean;
    startupStreamStatus: StartupStreamStatus;
    forceStartupTelegram: boolean;
    lastNotifiedStreamStartedAt: number | null;
    startedAt: string;
}): TelegramStreamOnlineDecision {
    const {
        isInitialStartup,
        startupStreamStatus,
        forceStartupTelegram,
        lastNotifiedStreamStartedAt,
        startedAt
    } = params;

    // Если это старт процесса в середине уже идущего стрима
    if (isInitialStartup && startupStreamStatus === 'online') {
        if (forceStartupTelegram) {
            return { action: 'send', mode: 'forced_startup' };
        }
        return { action: 'skip_initial_startup', reason: 'startup_stream_online' };
    }

    // Обычная логика: не дублировать один и тот же эфир.
    if (!shouldSendTelegramStreamOnlineForStartedAt(lastNotifiedStreamStartedAt, startedAt)) {
        return { action: 'skip_duplicate', reason: 'same_started_at' };
    }

    return { action: 'send', mode: 'normal' };
}

/**
 * Определить, является ли наблюдение "стрим онлайн со started_at" новым стартом стрима
 * (т.е. переходом offline→online или сменой started_at = новый эфир).
 *
 * Нужен, чтобы при рестарте процесса в середине стрима не слать повторное TG-уведомление.
 */
export function isStreamOnlineTransition(params: {
    lastKnown: LastKnownStreamState;
    observedStartedAtMs: number;
}): boolean {
    const { lastKnown, observedStartedAtMs } = params;
    if (lastKnown.status !== 'online') {
        return true;
    }
    if (lastKnown.startedAtMs === null) {
        // Если почему-то мы считали online, но started_at не знаем — считаем переходом, чтобы не потерять уведомление.
        return true;
    }
    return lastKnown.startedAtMs !== observedStartedAtMs;
}

export function isStreamOnlineTransitionWithRecentOffline(params: {
    lastKnown: LastKnownStreamState;
    observedStartedAtMs: number;
    lastOfflineAtMs: number | null;
    nowMs: number;
    offlineBounceWindowMs: number;
}): boolean {
    const base = isStreamOnlineTransition({
        lastKnown: params.lastKnown,
        observedStartedAtMs: params.observedStartedAtMs
    });
    if (base) return true;
    if (params.lastOfflineAtMs == null) return false;
    return params.nowMs - params.lastOfflineAtMs < params.offlineBounceWindowMs;
}

export type TelegramStreamOfflineDecision =
    | { action: 'skip'; reason: 'already_offline' }
    | { action: 'send' };

/**
 * Решение для TG «стрим оффлайн»:
 * отправляем только на переход online→offline (персистентный lastKnown), чтобы не дублировать на рестартах.
 */
export function decideTelegramStreamOffline(params: {
    lastKnown: LastKnownStreamState;
}): TelegramStreamOfflineDecision {
    if (params.lastKnown.status !== 'online') {
        return { action: 'skip', reason: 'already_offline' };
    }
    return { action: 'send' };
}
