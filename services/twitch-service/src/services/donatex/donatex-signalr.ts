import { WebSocket } from 'ws';
import { DonateXDonation } from './types';
import { normalizeDonateXDonation } from './donatex-normalize';

// SignalR в Node.js требует WebSocket из пакета ws
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = WebSocket;

type SignalRModule = typeof import('@microsoft/signalr');
type HubConnection = import('@microsoft/signalr').HubConnection;
type HubConnectionState = import('@microsoft/signalr').HubConnectionState;

export type DonateXDonationHandler = (
  donation: DonateXDonation,
  raw: Record<string, unknown>
) => void | Promise<void>;

export interface DonateXSignalROptions {
  token: string;
  apiBaseUrl?: string;
  onDonation: DonateXDonationHandler;
  onConnected?: () => void;
  onDisconnected?: (error?: Error) => void;
}

let connection: HubConnection | null = null;
let signalrModule: SignalRModule | null = null;

async function loadSignalRModule(): Promise<SignalRModule> {
  if (signalrModule) {
    return signalrModule;
  }
  try {
    signalrModule = await import('@microsoft/signalr');
    return signalrModule;
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err);
    throw new Error(
      `[DONATEX_SIGNALR] Пакет @microsoft/signalr не установлен (${msg}). ` +
        'На сервере: npm install --registry https://registry.npmjs.org/'
    );
  }
}

function hubUrl(token: string, apiBaseUrl?: string): string {
  const base = (apiBaseUrl ?? 'https://donatex.gg/api').replace(/\/$/, '');
  return `${base}/public-donations-hub?access_token=${encodeURIComponent(token)}`;
}

export async function startDonateXSignalR(options: DonateXSignalROptions): Promise<void> {
  const { HubConnectionBuilder, HubConnectionState, LogLevel } = await loadSignalRModule();

  if (connection?.state === HubConnectionState.Connected) {
    return;
  }

  await stopDonateXSignalR();

  connection = new HubConnectionBuilder()
    .withUrl(hubUrl(options.token, options.apiBaseUrl))
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .configureLogging(LogLevel.Warning)
    .build();

  connection.on('DonationCreated', async (payload: unknown) => {
    try {
      const raw =
        payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
      const donation = normalizeDonateXDonation(raw);
      if (!donation) {
        console.warn('[DONATEX_SIGNALR] DonationCreated: не удалось разобрать payload');
        return;
      }
      await options.onDonation(donation, raw);
    } catch (err) {
      console.error('[DONATEX_SIGNALR] Ошибка обработки DonationCreated:', err);
    }
  });

  connection.onreconnected(() => {
    console.log('✅ [DONATEX_SIGNALR] Переподключено');
    options.onConnected?.();
  });

  connection.onclose((err?: Error) => {
    const error = err ? new Error(err.message) : undefined;
    console.warn('[DONATEX_SIGNALR] Соединение закрыто', err?.message ?? '');
    options.onDisconnected?.(error);
  });

  await connection.start();
  console.log('✅ [DONATEX_SIGNALR] Подключено к public-donations-hub');
  options.onConnected?.();
}

export async function stopDonateXSignalR(): Promise<void> {
  if (!connection) {
    return;
  }
  try {
    const { HubConnectionState } = await loadSignalRModule();
    if (connection.state !== HubConnectionState.Disconnected) {
      await connection.stop();
    }
  } catch (err) {
    console.warn('[DONATEX_SIGNALR] Ошибка при остановке:', err);
  } finally {
    connection = null;
  }
}

export function getDonateXSignalRState(): string {
  return connection?.state ?? 'none';
}
