/**
 * Тестовый скрипт для отправки уведомления о начале стрима в Telegram
 * Запуск: npm run stream:notification:test
 */

import { Telegraf } from 'telegraf';
import { loadConfig } from '../config/env';

async function main() {
    const config = loadConfig();

    if (!config.telegram.channelId) {
        console.error('❌ CHANNEL_ID не указан в .env');
        process.exit(1);
    }

    console.log('📤 Отправка тестового уведомления...');
    console.log('   Канал:', config.telegram.channelId);

    const bot = new Telegraf(config.telegram.token);

    const testMessage = `
🟢 <b>Стрим начался!</b>

<b>Канал:</b> ${config.twitch.channel}
<b>Категория:</b> Just Chatting
<b>Название:</b> Тестовый стрим

🔗 <a href="https://twitch.tv/${config.twitch.channel}">${config.twitch.channel}</a>
    `.trim();

    try {
        await bot.telegram.sendMessage(config.telegram.channelId, testMessage, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: false }
        });

        console.log('✅ Тестовое уведомление отправлено!');
    } catch (error: any) {
        console.error('❌ Ошибка отправки:', error.message);
    }

    process.exit(0);
}

main();
