import { DonateXDonation } from './types';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Строка с явным UTC/offset — парсим как есть. */
function hasExplicitTimezone(ts: string): boolean {
  return /[zZ]$/.test(ts) || /[+-]\d{2}:?\d{2}$/.test(ts);
}

/**
 * DonateX часто отдаёт время без offset — это местное (Europe/Moscow), не UTC.
 * На сервере в UTC `new Date('2026-04-09T00:57:00')` сдвигает донат на +3ч и ломает окно стрима.
 */
export function parseDonateXTimestamp(ts: string): Date {
  const trimmed = ts.trim();
  if (!trimmed) {
    return new Date(Number.NaN);
  }

  if (hasExplicitTimezone(trimmed)) {
    return new Date(trimmed);
  }

  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const m = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/
  );
  if (!m) {
    return new Date(trimmed);
  }

  const [, y, mo, d, hh, mm, ss = '0'] = m;
  return new Date(
    Date.UTC(
      parseInt(y, 10),
      parseInt(mo, 10) - 1,
      parseInt(d, 10),
      parseInt(hh, 10),
      parseInt(mm, 10),
      parseInt(ss, 10)
    ) - MSK_OFFSET_MS
  );
}

export function normalizeDonateXDonation(raw: Record<string, unknown>): DonateXDonation | null {
  const id = String(raw.id ?? '').trim();
  const username = String(raw.username ?? '').trim();
  if (!id || !username) {
    return null;
  }

  const amount = Number(raw.amount);
  const amountInRub = Number(raw.amountInRub ?? raw.amount_in_rub ?? amount);
  const currency = String(raw.currency ?? 'RUB').trim() || 'RUB';
  const timestamp = String(raw.timestamp ?? raw.donated_at ?? '').trim();
  if (!timestamp) {
    return null;
  }

  return {
    id,
    username,
    message: String(raw.message ?? ''),
    withAiResponse: Boolean(raw.withAiResponse ?? raw.with_ai_response),
    currency,
    amount: Number.isFinite(amount) ? amount : 0,
    amountInRub: Number.isFinite(amountInRub) ? amountInRub : 0,
    timestamp,
    aiResponse: raw.aiResponse != null ? String(raw.aiResponse) : raw.ai_response != null ? String(raw.ai_response) : null,
    isTest: Boolean(raw.isTest ?? raw.is_test),
  };
}
