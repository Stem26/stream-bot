import type {
  ApiCallResult,
  GateResult,
  StreamsApiContext,
  TwitchAnnouncementInput,
  TwitchStreamData,
} from './twitch-api.types';

const API_FETCH_TIMEOUT_MS = 8000;

export class ApiBackoffGate {
  private nextAllowedAt = 0;
  private failureCount = 0;
  private lastCallAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly maxBackoffMs: number
  ) {}

  shouldSkip(): GateResult {
    const now = Date.now();

    if (now < this.nextAllowedAt) {
      return {
        skip: true,
        reason: 'backoff',
        waitMs: this.nextAllowedAt - now,
      };
    }

    const elapsed = now - this.lastCallAt;
    if (this.lastCallAt > 0 && elapsed < this.minIntervalMs) {
      return {
        skip: true,
        reason: 'rate_limit',
        waitMs: this.minIntervalMs - elapsed,
      };
    }

    return { skip: false };
  }

  markCall(): void {
    this.lastCallAt = Date.now();
  }

  registerFailure(retryAfterMs?: number): { delayMs: number; failureCount: number } {
    this.failureCount += 1;
    const exp = Math.min(this.failureCount, 6);
    const base = Math.pow(2, exp) * 5000;
    const jitter = Math.floor(Math.random() * 1000);
    const delayMs = Math.min(this.maxBackoffMs, Math.max(base + jitter, retryAfterMs ?? 0));

    this.nextAllowedAt = Date.now() + delayMs;
    return { delayMs, failureCount: this.failureCount };
  }

  registerSuccess(): { hadFailures: boolean; failureCount: number } {
    const hadFailures = this.failureCount > 0 || this.nextAllowedAt > 0;
    const failureCount = this.failureCount;
    this.failureCount = 0;
    this.nextAllowedAt = 0;
    return { hadFailures, failureCount };
  }
}

type TwitchApiClientOptions = {
  accessToken: string;
  clientId: string;
  streamsGate: ApiBackoffGate;
  announcementsGate: ApiBackoffGate;
};

export class TwitchApiClient {
  constructor(private readonly opts: TwitchApiClientOptions) {}

  private buildHeaders(contentTypeJson = false): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.accessToken}`,
      'Client-Id': this.opts.clientId,
    };
    if (contentTypeJson) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private parseRetryAfterMs(headerValue: string | null): number | null {
    if (!headerValue) return null;

    const asSeconds = Number(headerValue);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;

    const asDateMs = Date.parse(headerValue);
    if (Number.isFinite(asDateMs)) return Math.max(0, asDateMs - Date.now());

    return null;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async getStreamByUserId(userId: string, context: StreamsApiContext): Promise<ApiCallResult<TwitchStreamData | null>> {
    const gate = this.opts.streamsGate.shouldSkip();
    if (gate.skip) {
      return {
        ok: false,
        skipped: true,
        reason: gate.reason ?? 'rate_limit',
        waitMs: gate.waitMs ?? 0,
      };
    }
    this.opts.streamsGate.markCall();

    try {
      const response = await this.fetchWithTimeout(
        `https://api.twitch.tv/helix/streams?user_id=${userId}`,
        { headers: this.buildHeaders() }
      );

      if (!response.ok) {
        const retryAfterMs = this.parseRetryAfterMs(response.headers.get('retry-after'));
        const backoff = this.opts.streamsGate.registerFailure(retryAfterMs ?? undefined);
        return {
          ok: false,
          skipped: false,
          error: `streams status=${response.status}`,
          type: 'http',
          status: response.status,
          backoffMs: backoff.delayMs,
          context,
        };
      }

      const json = (await response.json()) as { data?: TwitchStreamData[] };
      const recovered = this.opts.streamsGate.registerSuccess();
      return {
        ok: true,
        data: json.data?.[0] ?? null,
        recovered: recovered.hadFailures,
        failureCountBeforeRecover: recovered.failureCount,
      };
    } catch (error: any) {
      const backoff = this.opts.streamsGate.registerFailure();
      const isTimeout = error?.name === 'AbortError';
      return {
        ok: false,
        skipped: false,
        error: isTimeout ? 'timeout' : (error?.message || String(error)),
        type: isTimeout ? 'timeout' : 'network',
        backoffMs: backoff.delayMs,
        context,
      };
    }
  }

  async sendAnnouncement(input: TwitchAnnouncementInput): Promise<ApiCallResult<null>> {
    const gate = this.opts.announcementsGate.shouldSkip();
    if (gate.skip) {
      return {
        ok: false,
        skipped: true,
        reason: gate.reason ?? 'rate_limit',
        waitMs: gate.waitMs ?? 0,
      };
    }
    this.opts.announcementsGate.markCall();

    try {
      const response = await this.fetchWithTimeout(
        `https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${input.broadcasterId}&moderator_id=${input.moderatorId}`,
        {
          method: 'POST',
          headers: this.buildHeaders(true),
          body: JSON.stringify({
            message: input.message,
            color: input.color,
          }),
        }
      );

      if (!response.ok) {
        const retryAfterMs = this.parseRetryAfterMs(response.headers.get('retry-after'));
        const backoff = this.opts.announcementsGate.registerFailure(retryAfterMs ?? undefined);
        const errorText = await response.text();
        return {
          ok: false,
          skipped: false,
          error: `announcement status=${response.status}: ${errorText}`,
          type: 'http',
          status: response.status,
          backoffMs: backoff.delayMs,
          context: input.context ?? 'links-rotation',
        };
      }

      const recovered = this.opts.announcementsGate.registerSuccess();

      return {
        ok: true,
        data: null,
        recovered: recovered.hadFailures,
        failureCountBeforeRecover: recovered.failureCount,
      };
    } catch (error: any) {
      const backoff = this.opts.announcementsGate.registerFailure();
      const isTimeout = error?.name === 'AbortError';
      return {
        ok: false,
        skipped: false,
        error: isTimeout ? 'timeout' : (error?.message || String(error)),
        type: isTimeout ? 'timeout' : 'network',
        backoffMs: backoff.delayMs,
        context: input.context ?? 'links-rotation',
      };
    }
  }

  async getUserByLoginUnguarded(login: string): Promise<ApiCallResult<{ id: string; display_name: string } | null>> {
    try {
      const response = await this.fetchWithTimeout(
        `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
        { headers: this.buildHeaders() }
      );

      if (!response.ok) {
        return {
          ok: false,
          skipped: false,
          error: `users status=${response.status}`,
          type: 'http',
          status: response.status,
          context: 'users:getByLogin',
        };
      }

      const json = (await response.json()) as { data?: Array<{ id: string; display_name: string }> };
      return { ok: true, data: json.data?.[0] ?? null };
    } catch (error: any) {
      const isTimeout = error?.name === 'AbortError';
      return {
        ok: false,
        skipped: false,
        error: isTimeout ? 'timeout' : (error?.message || String(error)),
        type: isTimeout ? 'timeout' : 'network',
        context: 'users:getByLogin',
      };
    }
  }
}

