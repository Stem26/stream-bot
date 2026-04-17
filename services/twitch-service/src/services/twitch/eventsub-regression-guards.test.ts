import { describe, it, expect } from 'vitest';
import {
    assertEventSubSubscribeBatchSession,
    computeEventSubWatchdogIssues,
    decideTelegramStreamOnline,
    decideTelegramStreamOffline,
    isStreamOnlineTransition,
    isStreamOnlineTransitionWithRecentOffline,
    shouldSendTelegramStreamOnlineForStartedAt,
    shouldSkipEventSubSubscribeCooldown,
    streamStartedAtToMs
} from './eventsub-regression-guards';

const EXPECTED_MS = 30_000;

describe('computeEventSubWatchdogIssues', () => {
    const base = {
        connectionState: 'connected' as const,
        wsSocketOpen: true,
        lastKeepaliveAt: 0,
        lastEventSubMessageAt: 0,
        expectedKeepaliveTimeoutMs: EXPECTED_MS
    };

    it('пустой список при здоровом connected + открытый ws и свежий keepalive', () => {
        const now = 1_000_000;
        const issues = computeEventSubWatchdogIssues({
            ...base,
            now,
            lastKeepaliveAt: now - 10_000,
            lastEventSubMessageAt: now
        });
        expect(issues).toEqual([]);
    });

    it('websocket_not_open при connected, но сокет не OPEN', () => {
        const issues = computeEventSubWatchdogIssues({
            ...base,
            now: 1_000_000,
            wsSocketOpen: false,
            lastKeepaliveAt: 1_000_000,
            lastEventSubMessageAt: 1_000_000
        });
        expect(issues).toContain('websocket_not_open');
    });

    it('не добавляет websocket_not_open в idle', () => {
        const issues = computeEventSubWatchdogIssues({
            ...base,
            connectionState: 'idle',
            now: 1_000_000,
            wsSocketOpen: false,
            lastKeepaliveAt: 0,
            lastEventSubMessageAt: 0
        });
        expect(issues).not.toContain('websocket_not_open');
    });

    it('keepalive_stale если keepalive старше 3× timeout', () => {
        const now = 200_000;
        const lastKa = now - EXPECTED_MS * 3 - 1;
        const issues = computeEventSubWatchdogIssues({
            ...base,
            now,
            lastKeepaliveAt: lastKa,
            lastEventSubMessageAt: now
        });
        expect(issues.some((i) => i.startsWith('keepalive_stale>'))).toBe(true);
    });

    it('eventsub_silent_no_keepalive если не было keepalive, но были сообщения и тишина > 3× timeout', () => {
        const now = 500_000;
        const lastMsg = now - EXPECTED_MS * 3 - 1;
        const issues = computeEventSubWatchdogIssues({
            ...base,
            now,
            lastKeepaliveAt: 0,
            lastEventSubMessageAt: lastMsg
        });
        expect(issues.some((i) => i.startsWith('eventsub_silent_no_keepalive>'))).toBe(true);
    });

    it('не считает silent если lastEventSubMessageAt === 0', () => {
        const now = 999_999_999;
        const issues = computeEventSubWatchdogIssues({
            ...base,
            now,
            lastKeepaliveAt: 0,
            lastEventSubMessageAt: 0
        });
        expect(issues.some((i) => i.includes('silent'))).toBe(false);
    });

    it('приоритет keepalive_stale над silent (else if в оригинале)', () => {
        const now = 1_000_000;
        const lastKa = now - EXPECTED_MS * 3 - 1000;
        const lastMsg = now - EXPECTED_MS * 3 - 1000;
        const issues = computeEventSubWatchdogIssues({
            ...base,
            now,
            lastKeepaliveAt: lastKa,
            lastEventSubMessageAt: lastMsg
        });
        expect(issues.filter((i) => i.startsWith('keepalive_stale')).length).toBe(1);
        expect(issues.some((i) => i.includes('silent'))).toBe(false);
    });
});

describe('shouldSkipEventSubSubscribeCooldown', () => {
    const sid = 'session-abc';
    const cooldownMs = 10_000;

    it('пропуск при той же session и интервал не вышел', () => {
        expect(
            shouldSkipEventSubSubscribeCooldown({
                now: 5000,
                batchSessionId: sid,
                lastSubscribeAt: 0,
                lastSubscribeCooldownSessionId: sid,
                cooldownMs
            })
        ).toBe(true);
    });

    it('не пропуск при другой session_id', () => {
        expect(
            shouldSkipEventSubSubscribeCooldown({
                now: 1000,
                batchSessionId: sid,
                lastSubscribeAt: 0,
                lastSubscribeCooldownSessionId: 'other',
                cooldownMs
            })
        ).toBe(false);
    });

    it('не пропуск после cooldown', () => {
        expect(
            shouldSkipEventSubSubscribeCooldown({
                now: 20_000,
                batchSessionId: sid,
                lastSubscribeAt: 0,
                lastSubscribeCooldownSessionId: sid,
                cooldownMs
            })
        ).toBe(false);
    });

    it('не пропуск при null lastSubscribeCooldownSessionId', () => {
        expect(
            shouldSkipEventSubSubscribeCooldown({
                now: 1000,
                batchSessionId: sid,
                lastSubscribeAt: 0,
                lastSubscribeCooldownSessionId: null,
                cooldownMs
            })
        ).toBe(false);
    });
});

describe('assertEventSubSubscribeBatchSession', () => {
    it('не бросает при совпадении', () => {
        expect(() => assertEventSubSubscribeBatchSession('a', 'a')).not.toThrow();
    });

    it('бросает при смене session', () => {
        expect(() => assertEventSubSubscribeBatchSession('b', 'a')).toThrow(
            'EventSub: session_id changed during subscribe batch'
        );
    });

    it('бросает если current null', () => {
        expect(() => assertEventSubSubscribeBatchSession(null, 'a')).toThrow();
    });
});

describe('Telegram stream start dedup', () => {
    it('streamStartedAtToMs парсит ISO', () => {
        const ms = streamStartedAtToMs('2024-01-15T12:00:00.000Z');
        expect(ms).toBe(Date.parse('2024-01-15T12:00:00.000Z'));
    });

    it('streamStartedAtToMs: невалид → null', () => {
        expect(streamStartedAtToMs('not-a-date')).toBeNull();
    });

    it('разрешает отправку если lastNotified не совпадает', () => {
        expect(
            shouldSendTelegramStreamOnlineForStartedAt(
                100,
                '2024-01-15T12:00:00.000Z'
            )
        ).toBe(true);
    });

    it('запрещает дубль для того же started_at', () => {
        const startedAt = '2024-01-15T12:00:00.000Z';
        const ms = streamStartedAtToMs(startedAt)!;
        expect(shouldSendTelegramStreamOnlineForStartedAt(ms, startedAt)).toBe(false);
    });

    it('при невалидном started_at разрешает (как в проде — не блокируем)', () => {
        expect(shouldSendTelegramStreamOnlineForStartedAt(123, 'bad')).toBe(true);
    });
});

describe('decideTelegramStreamOnline', () => {
    const startedAt = '2024-01-15T12:00:00.000Z';
    const startedAtMs = streamStartedAtToMs(startedAt)!;

    it('skip_initial_startup если старт процесса и стрим уже онлайн (по умолчанию)', () => {
        expect(
            decideTelegramStreamOnline({
                isInitialStartup: true,
                startupStreamStatus: 'online',
                forceStartupTelegram: false,
                lastNotifiedStreamStartedAt: null,
                startedAt
            })
        ).toEqual({ action: 'skip_initial_startup', reason: 'startup_stream_online' });
    });

    it('forced_startup отправляет при старте процесса в онлайне если включен флаг', () => {
        expect(
            decideTelegramStreamOnline({
                isInitialStartup: true,
                startupStreamStatus: 'online',
                forceStartupTelegram: true,
                lastNotifiedStreamStartedAt: startedAtMs,
                startedAt
            })
        ).toEqual({ action: 'send', mode: 'forced_startup' });
    });

    it('normal отправляет при старте в оффлайне (первый online)', () => {
        expect(
            decideTelegramStreamOnline({
                isInitialStartup: true,
                startupStreamStatus: 'offline',
                forceStartupTelegram: false,
                lastNotifiedStreamStartedAt: null,
                startedAt
            })
        ).toEqual({ action: 'send', mode: 'normal' });
    });

    it('unknown не подавляет (защита от сбоя стартового probe)', () => {
        expect(
            decideTelegramStreamOnline({
                isInitialStartup: true,
                startupStreamStatus: 'unknown',
                forceStartupTelegram: false,
                lastNotifiedStreamStartedAt: null,
                startedAt
            })
        ).toEqual({ action: 'send', mode: 'normal' });
    });

    it('skip_duplicate если уже уведомляли для этого started_at', () => {
        expect(
            decideTelegramStreamOnline({
                isInitialStartup: false,
                startupStreamStatus: 'offline',
                forceStartupTelegram: false,
                lastNotifiedStreamStartedAt: startedAtMs,
                startedAt
            })
        ).toEqual({ action: 'skip_duplicate', reason: 'same_started_at' });
    });
});

describe('isStreamOnlineTransition', () => {
    it('true при lastKnown=offline', () => {
        expect(
            isStreamOnlineTransition({
                lastKnown: { status: 'offline', startedAtMs: null },
                observedStartedAtMs: 123
            })
        ).toBe(true);
    });

    it('false если lastKnown=online и started_at не поменялся (рестарт/рекавери того же стрима)', () => {
        expect(
            isStreamOnlineTransition({
                lastKnown: { status: 'online', startedAtMs: 999 },
                observedStartedAtMs: 999
            })
        ).toBe(false);
    });

    it('true если lastKnown=online и started_at поменялся (новый эфир)', () => {
        expect(
            isStreamOnlineTransition({
                lastKnown: { status: 'online', startedAtMs: 100 },
                observedStartedAtMs: 200
            })
        ).toBe(true);
    });

    it('true если lastKnown=online, но startedAtMs=null (не теряем уведомление)', () => {
        expect(
            isStreamOnlineTransition({
                lastKnown: { status: 'online', startedAtMs: null },
                observedStartedAtMs: 1
            })
        ).toBe(true);
    });
});

describe('isStreamOnlineTransitionWithRecentOffline', () => {
    it('true если started_at тот же, но был недавний оффлайн (bounce)', () => {
        const now = 1_000_000;
        expect(
            isStreamOnlineTransitionWithRecentOffline({
                lastKnown: { status: 'online', startedAtMs: 100 },
                observedStartedAtMs: 100,
                lastOfflineAtMs: now - 1000,
                nowMs: now,
                offlineBounceWindowMs: 10_000
            })
        ).toBe(true);
    });

    it('false если started_at тот же и оффлайн был давно', () => {
        const now = 1_000_000;
        expect(
            isStreamOnlineTransitionWithRecentOffline({
                lastKnown: { status: 'online', startedAtMs: 100 },
                observedStartedAtMs: 100,
                lastOfflineAtMs: now - 60_000,
                nowMs: now,
                offlineBounceWindowMs: 10_000
            })
        ).toBe(false);
    });
});

describe('decideTelegramStreamOffline', () => {
    it('skip если lastKnown уже offline', () => {
        expect(
            decideTelegramStreamOffline({
                lastKnown: { status: 'offline', startedAtMs: null }
            })
        ).toEqual({ action: 'skip', reason: 'already_offline' });
    });

    it('send если lastKnown online (переход online→offline)', () => {
        expect(
            decideTelegramStreamOffline({
                lastKnown: { status: 'online', startedAtMs: 123 }
            })
        ).toEqual({ action: 'send' });
    });
});
