export type ApiSkipReason = 'backoff' | 'rate_limit';
export type ApiErrorType = 'timeout' | 'http' | 'network';

export type ApiGateSkip = {
  skip: true;
  reason: ApiSkipReason;
  waitMs: number;
};

export type GateResult = ApiGateSkip | { skip: false };

export type ApiOk<T> = {
  ok: true;
  data: T;
  recovered?: boolean;
  failureCountBeforeRecover?: number;
};

export type ApiSkipped = {
  ok: false;
  skipped: true;
  reason: ApiSkipReason;
  waitMs: number;
};

export type ApiFailed = {
  ok: false;
  skipped: false;
  error: string;
  type: ApiErrorType;
  status?: number;
  backoffMs?: number;
  context: string;
};

export type ApiCallResult<T> = ApiOk<T> | ApiSkipped | ApiFailed;

export function isApiOk<T>(result: ApiCallResult<T>): result is ApiOk<T> {
  return result.ok;
}

export function isApiSkipped<T>(result: ApiCallResult<T>): result is ApiSkipped {
  return result.ok === false && result.skipped === true;
}

export function isApiFailed<T>(result: ApiCallResult<T>): result is ApiFailed {
  return result.ok === false && result.skipped === false;
}

export type StreamsApiContext =
  | 'probe:startup'
  | 'probe:timer:offline-poll'
  | 'probe:event:channel.follow'
  | 'probe:event:channel.raid'
  | 'viewers:record'
  | 'telegram:stream_notification'
  | string;

export type AnnouncementContext = 'links-rotation' | string;

export type TwitchStreamData = {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_name?: string;
  title: string;
  viewer_count: number;
  started_at: string;
};

export type TwitchAnnouncementInput = {
  broadcasterId: string;
  moderatorId: string;
  message: string;
  color: string;
  context?: AnnouncementContext;
};

