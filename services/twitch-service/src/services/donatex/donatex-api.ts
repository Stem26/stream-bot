import { DonateXDonation } from './types';
import { normalizeDonateXDonation } from './donatex-normalize';

const DEFAULT_BASE = 'https://donatex.gg/api';
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 150;

export interface DonateXApiClientOptions {
  token: string;
  baseUrl?: string;
  hideTest?: boolean;
}

export async function fetchDonateXDonationsPage(
  options: DonateXApiClientOptions,
  skip: number,
  take: number = PAGE_SIZE
): Promise<DonateXDonation[]> {
  const base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const url = new URL(`${base}/v1/donations`);
  url.searchParams.set('skip', String(skip));
  url.searchParams.set('take', String(take));
  url.searchParams.set('token', options.token);
  if (options.hideTest !== false) {
    url.searchParams.set('hideTest', 'true');
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (res.status === 429) {
    throw new Error('[DONATEX_API] 429 Too Many Requests — снизьте частоту запросов');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[DONATEX_API] ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('[DONATEX_API] Ожидался массив донатов');
  }

  const out: DonateXDonation[] = [];
  for (const item of data) {
    if (item && typeof item === 'object') {
      const normalized = normalizeDonateXDonation(item as Record<string, unknown>);
      if (normalized) {
        out.push(normalized);
      }
    }
  }
  return out;
}

/** Загружает всю историю донатов (пагинация). */
export async function fetchAllDonateXDonations(
  options: DonateXApiClientOptions,
  onPage?: (page: DonateXDonation[], skip: number) => void | Promise<void>
): Promise<DonateXDonation[]> {
  const all: DonateXDonation[] = [];
  let skip = 0;

  for (;;) {
    const page = await fetchDonateXDonationsPage(options, skip, PAGE_SIZE);
    if (page.length === 0) {
      break;
    }
    all.push(...page);
    if (onPage) {
      await onPage(page, skip);
    }
    skip += page.length;
    if (page.length < PAGE_SIZE) {
      break;
    }
    await sleep(PAGE_DELAY_MS);
  }

  return all;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
