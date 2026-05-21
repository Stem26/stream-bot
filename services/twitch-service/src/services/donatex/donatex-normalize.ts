import { DonateXDonation } from './types';

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
