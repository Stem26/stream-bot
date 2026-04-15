/**
 * Скрипт для удаления последних сообщений из Telegram канала
 * Используется для очистки после тестирования
 *
 * Запуск: node scripts/delete-telegram-messages.js <количество> <channel_id> <bot_token>
 * Пример: node scripts/delete-telegram-messages.js 10 -1001234567890 123456:ABC-DEF...
 */

const https = require('https');

const args = process.argv.slice(2);

if (args.length < 3) {
    console.log('❌ Использование: node delete-telegram-messages.js <количество> <channel_id> <bot_token>');
    console.log('   Пример: node delete-telegram-messages.js 10 -1001234567890 123456:ABC-DEF...');
    process.exit(1);
}

const COUNT = parseInt(args[0], 10);
const CHANNEL_ID = args[1];
const BOT_TOKEN = args[2];

if (isNaN(COUNT) || COUNT < 1 || COUNT > 100) {
    console.error('❌ Количество должно быть от 1 до 100');
    process.exit(1);
}

/**
 * Выполняет запрос к Telegram API
 */
function telegramRequest(method, data = {}) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(data);

        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';

            res.on('data', (chunk) => {
                body += chunk;
            });

            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (result.ok) {
                        resolve(result.result);
                    } else {
                        reject(new Error(result.description || 'Unknown error'));
                    }
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

/**
 * Получает информацию о канале
 */
async function getChat() {
    try {
        const chat = await telegramRequest('getChat', { chat_id: CHANNEL_ID });
        console.log(`✅ Найден канал: ${chat.title || chat.username || CHANNEL_ID}`);
        return chat;
    } catch (error) {
        console.error(`❌ Ошибка получения информации о канале: ${error.message}`);
        throw error;
    }
}

/**
 * Удаляет сообщение
 */
async function deleteMessage(messageId) {
    try {
        await telegramRequest('deleteMessage', {
            chat_id: CHANNEL_ID,
            message_id: messageId
        });
        return true;
    } catch {
        // Сообщение может быть уже удалено или недоступно
        return false;
    }
}

/**
 * Основная функция
 */
async function main() {
    console.log('🗑️  Удаление сообщений из Telegram канала...\n');

    try {
        // Проверяем доступ к каналу
        await getChat();

        console.log(`\n⚠️  ВНИМАНИЕ: Будет попытка удалить до ${COUNT} последних сообщений!`);
        console.log('   Начинаем через 3 секунды...\n');

        await new Promise(resolve => setTimeout(resolve, 3000));

        // Telegram не предоставляет метод для получения списка сообщений
        // Поэтому мы пытаемся удалить последние N сообщений методом перебора

        // Сначала отправляем тестовое сообщение чтобы получить message_id
        const testMsg = await telegramRequest('sendMessage', {
            chat_id: CHANNEL_ID,
            text: '🗑️ Очистка...'
        });

        const currentMessageId = testMsg.message_id;

        // Удаляем тестовое сообщение
        await deleteMessage(currentMessageId);

        console.log('🔄 Начинаем удаление...\n');

        let deletedCount = 0;
        let failedCount = 0;

        // Удаляем последние N сообщений
        for (let i = 0; i < COUNT; i++) {
            const messageId = currentMessageId - i - 1;

            const success = await deleteMessage(messageId);

            if (success) {
                deletedCount++;
                console.log(`✅ Удалено сообщение #${messageId}`);
            } else {
                failedCount++;
                console.log(`⚠️  Не удалось удалить сообщение #${messageId} (возможно уже удалено или старше 48 часов)`);
            }

            // Небольшая задержка чтобы не попасть под rate limit
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        console.log('\n📊 Результат:');
        console.log(`   ✅ Удалено: ${deletedCount}`);
        console.log(`   ⚠️  Пропущено: ${failedCount}`);
        console.log('\n✅ Готово!');

    } catch (error) {
        console.error(`\n❌ Ошибка: ${error.message}`);
        process.exit(1);
    }
}

main();
