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
