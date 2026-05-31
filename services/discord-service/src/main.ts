import { loadConfig } from './config/env';
import { createLogger } from './utils/logger';
import { enableWindowsUtf8Console } from './utils/consoleEncoding';
import { VoiceChannelGuard } from './services/VoiceChannelGuard';

async function main(): Promise<void> {
  enableWindowsUtf8Console();
  const config = loadConfig();
  const logger = createLogger(config);
  const guard = new VoiceChannelGuard(config, logger);

  const shutdown = async (signal: string) => {
    logger.info({ signal, pid: process.pid }, 'Получен сигнал остановки процесса');
    await guard.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  try {
    logger.info('Запуск Discord voice guard');
    await guard.start();
  } catch (error) {
    logger.error({ err: error }, 'Ошибка запуска Discord guard');
    process.exit(1);
  }
}

void main();
