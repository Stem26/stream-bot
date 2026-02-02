import pino from 'pino';
import { AppConfig } from '../types/config';

/**
 * Создает настроенный logger
 */
export function createLogger(config: AppConfig) {
  const isProduction = !config.isLocal;

  return pino({
    level: config.isLocal ? 'debug' : 'info',
    
    // Красивый вывод в dev режиме
    transport: config.isLocal ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
        singleLine: false,
        messageFormat: '{levelLabel} {msg}',
      }
    } : undefined,

    // В продакшене - JSON формат
    formatters: !config.isLocal ? {
      level: (label) => {
        return { level: label };
      },
    } : undefined,
  });
}

/**
 * Глобальный logger (инициализируется в index.ts)
 */
let globalLogger: pino.Logger | null = null;

export function setGlobalLogger(logger: pino.Logger) {
  globalLogger = logger;
}

export function getLogger(): pino.Logger {
  if (!globalLogger) {
    throw new Error('Logger not initialized! Call setGlobalLogger first.');
  }

  return globalLogger;
}

/**
 * Создать child logger с дополнительным контекстом
 */
export function createChildLogger(context: Record<string, any>): pino.Logger {
  return getLogger().child(context);
}
