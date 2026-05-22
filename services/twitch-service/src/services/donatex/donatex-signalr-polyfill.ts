import { WebSocket } from 'ws';

// SignalR в Node.js подхватывает WebSocket при первой загрузке @microsoft/signalr.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = WebSocket;
