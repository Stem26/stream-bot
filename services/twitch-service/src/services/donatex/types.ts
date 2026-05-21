export interface DonateXDonation {
  id: string;
  username: string;
  message?: string;
  withAiResponse?: boolean;
  currency: string;
  amount: number;
  amountInRub: number;
  timestamp: string;
  aiResponse?: string | null;
  isTest?: boolean;
}

export type DonateXDonationSource = 'api_backfill' | 'signalr' | 'reconcile';
