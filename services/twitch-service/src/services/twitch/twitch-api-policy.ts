import { isApiFailed, isApiSkipped, type ApiCallResult } from './twitch-api.types';

export const API_SKIP_EVENTS = {
    STREAMS: 'STREAMS_API_SKIP',
    ANNOUNCEMENTS: 'ANNOUNCEMENTS_API_SKIP'
} as const;

export type ApiSkipEvent = typeof API_SKIP_EVENTS[keyof typeof API_SKIP_EVENTS];

export type ApiPolicyMeta = {
    skipEvent: ApiSkipEvent;
    errorContext: string;
};

export type ApiPolicyLogFn = (
    type: 'ERROR' | ApiPolicyMeta['skipEvent'],
    data: any
) => void;

export function handleApiResult<T>(
    result: ApiCallResult<T>,
    options: {
        context: string;
        apiMeta: ApiPolicyMeta;
        lastSkipAt: number;
        setLastSkipAt: (ts: number) => void;
        skipLogThrottleMs: number;
        log: ApiPolicyLogFn;
    }
): 'ok' | 'skip' | 'failed' {
    if (isApiSkipped(result)) {
        const now = Date.now();
        if (now - options.lastSkipAt > options.skipLogThrottleMs) {
            options.setLastSkipAt(now);
            options.log(options.apiMeta.skipEvent, {
                reason: result.reason,
                waitMs: result.waitMs,
                context: options.context
            });
        }
        return 'skip';
    }

    if (isApiFailed(result)) {
        options.log('ERROR', {
            context: options.apiMeta.errorContext,
            error: result.error,
            errorType: result.type,
            reason: options.context,
            status: result.status,
            backoffMs: result.backoffMs
        });
        return 'failed';
    }

    return 'ok';
}
