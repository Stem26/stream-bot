import pino from 'pino';
import { AppConfig } from '../types/config';

const MOSCOW_TIMEZONE = 'Europe/Moscow';

function getMoscowTimePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  for (const part of parts) {
    if (part.type === type) {
      return part.value;
    }
  }

  return '00';
}

export function formatMoscowLogTime(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MOSCOW_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const day = getMoscowTimePart(parts, 'day');
  const month = getMoscowTimePart(parts, 'month');
  const year = getMoscowTimePart(parts, 'year');
  const hour = getMoscowTimePart(parts, 'hour');
  const minute = getMoscowTimePart(parts, 'minute');
  const second = getMoscowTimePart(parts, 'second');

  return `${day}.${month}.${year} ${hour}:${minute}:${second} MSK`;
}

export function createLogger(config: AppConfig) {
  return pino({
    level: config.isLocal ? 'debug' : 'info',
    timestamp: () => `,"time":"${formatMoscowLogTime()}"`,
    transport: config.isLocal ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: false,
        ignore: 'pid,hostname',
        singleLine: false,
        messageFormat: '{msg}',
      },
    } : undefined,
    formatters: !config.isLocal ? {
      level: (label) => {
        return { level: label };
      },
    } : undefined,
  });
}
