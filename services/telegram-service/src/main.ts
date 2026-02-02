import { loadConfig } from './config/env';
import { initServices } from './app/initServices';
import { createBot } from './app/createBot';
import { registerCommands, setupBotCommands } from './app/registerCommands';
import { setupMiddlewares } from './app/setupMiddlewares';
import { setupErrorHandlers } from './app/errorHandlers';

/**
 * Главная функция запуска бота
 */
async function main() {
  try {
    // 1. Загружаем конфигурацию
    console.log('⚙️ Загрузка конфигурации...');
    const config = loadConfig();

    // Вывод информации о режиме работы
    if (config.isLocal) {
      console.log('==================================================');
      console.log('🔧 ЛОКАЛЬНЫЙ РЕЖИМ РАЗРАБОТКИ');
      console.log('==================================================');
    }

    // 2. Инициализируем сервисы (DI)
    const services = initServices();

    // 3. Создаем экземпляр бота с DI
    console.log('🤖 Создание экземпляра бота...');
    const bot = createBot(config, services);

    // 4. Регистрируем команды
    console.log('📝 Регистрация команд...');
    registerCommands(bot);

    // 5. Настраиваем middleware
    console.log('⚙️ Настройка middleware...');
    setupMiddlewares(bot);

    // 6. Настраиваем обработчики ошибок
    setupErrorHandlers(bot);

    // 7. Проверяем соединение с Telegram
    console.log('🔌 Проверка соединения с Telegram...');
    await bot.telegram.getMe();

    // 8. Настраиваем команды в Telegram
    console.log('📋 Настройка команд в Telegram...');
    await setupBotCommands(bot);

    // 9. Запускаем бота
    console.log('🎉 Бот полностью настроен!');
    console.log('🚀 Запуск Telegram бота...');
    await bot.launch();

    // 10. Настраиваем graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`🛑 Получен сигнал ${signal}, останавливаем бота...`);
      bot.stop(signal);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    console.log('❌ Ошибка при запуске бота:', error);
    process.exit(1);
  }
}

// Запускаем приложение
main();
