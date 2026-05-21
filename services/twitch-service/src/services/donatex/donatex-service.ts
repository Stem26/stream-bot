import { DONATEX_EXTERNAL_TOKEN } from '../../config/env';
import { initDonateXDatabase, closeDonateXDatabase, getDonateXPool } from '../../database/donatex-database';
import { fetchDonateXDonationsPage } from './donatex-api';
import {
  saveDonateXDonation,
  rebuildDonateXDonorStats,
  getDonateXStats,
  purgeDonateXLocalSeedDonations,
} from './donatex-storage';
import { startDonateXSignalR, stopDonateXSignalR } from './donatex-signalr';
import { DonateXDonation } from './types';

const RECONCILE_INTERVAL_MS = Math.max(
  60_000,
  parseInt(process.env.DONATEX_RECONCILE_INTERVAL_MS ?? '600000', 10) || 600_000
);
const BACKFILL_ON_START = process.env.DONATEX_BACKFILL_ON_START !== 'false';
const API_BASE = process.env.DONATEX_API_BASE_URL?.trim() || 'https://donatex.gg/api';
const HIDE_TEST = process.env.DONATEX_HIDE_TEST !== 'false';

let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function handleDonation(
  donation: DonateXDonation,
  source: 'api_backfill' | 'signalr' | 'reconcile',
  raw?: Record<string, unknown>
): Promise<void> {
  const result = await saveDonateXDonation(donation, source, raw);
  if (result.inserted && source === 'signalr') {
    console.log(
      `[DONATEX] Новый донат: ${donation.username} ${donation.amount} ${donation.currency} (${donation.amountInRub} RUB)`
    );
  }
}

async function backfillHistory(token: string): Promise<void> {
  console.log('[DONATEX] Загрузка истории донатов...');
  let skip = 0;
  let totalSaved = 0;
  let pages = 0;

  for (;;) {
    const page = await fetchDonateXDonationsPage(
      { token, baseUrl: API_BASE, hideTest: HIDE_TEST },
      skip,
      100
    );
    if (page.length === 0) {
      break;
    }

    for (const d of page) {
      await saveDonateXDonation(d, 'api_backfill');
      totalSaved++;
    }

    pages++;
    skip += page.length;
    if (page.length < 100) {
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  await rebuildDonateXDonorStats();
  const stats = await getDonateXStats();
  console.log(
    `[DONATEX] Backfill: страниц=${pages}, обработано=${totalSaved}, в БД донатов=${stats.donations}, донатеров=${stats.donors}`
  );
}

async function reconcileRecent(token: string): Promise<void> {
  try {
    const page = await fetchDonateXDonationsPage(
      { token, baseUrl: API_BASE, hideTest: HIDE_TEST },
      0,
      50
    );
    let newCount = 0;
    for (const d of page) {
      const r = await saveDonateXDonation(d, 'reconcile');
      if (r.inserted) {
        newCount++;
      }
    }
    if (newCount > 0) {
      await rebuildDonateXDonorStats();
      console.log(`[DONATEX] Reconcile: добавлено пропущенных донатов: ${newCount}`);
    }
  } catch (err) {
    console.warn('[DONATEX] Reconcile ошибка:', err);
  }
}

/** Запуск DonateX: БД → при токене: backfill + SignalR. */
export async function startDonateXIntegration(): Promise<void> {
  if (running) {
    return;
  }

  const dbOk = await initDonateXDatabase();
  if (!dbOk || !getDonateXPool()) {
    console.warn(
      '⚠️ [DONATEX] БД недоступна — добавьте DATABASE_URL в .env или .env.local (корень stream-bot)'
    );
    return;
  }

  await purgeDonateXLocalSeedDonations();

  const token = DONATEX_EXTERNAL_TOKEN;
  if (!token) {
    console.log('ℹ️ [DONATEX] DONATEX_EXTERNAL_TOKEN не задан — только БД (без API/SignalR)');
    running = true;
    return;
  }

  running = true;

  if (BACKFILL_ON_START) {
    void backfillHistory(token).catch((err) => {
      console.error('❌ [DONATEX] Backfill ошибка:', err);
    });
  }

  try {
    await startDonateXSignalR({
      token,
      apiBaseUrl: API_BASE,
      onDonation: (d, raw) => handleDonation(d, 'signalr', raw),
      onDisconnected: () => {
        console.warn('[DONATEX] SignalR отключён — новые донаты до reconnect не придут; reconcile подстрахует');
      },
    });
  } catch (err) {
    console.error('❌ [DONATEX] SignalR не подключился:', err);
    console.warn('[DONATEX] Бот продолжит работу; включится только reconcile по REST');
  }

  reconcileTimer = setInterval(() => {
    void reconcileRecent(token);
  }, RECONCILE_INTERVAL_MS);

  const stats = await getDonateXStats();
  console.log(
    `✅ [DONATEX] Интеграция активна (донатов=${stats.donations}, донатеров=${stats.donors}, reconcile=${RECONCILE_INTERVAL_MS / 1000}s)`
  );
}

export async function stopDonateXIntegration(): Promise<void> {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  await stopDonateXSignalR();
  await closeDonateXDatabase();
  running = false;
}
