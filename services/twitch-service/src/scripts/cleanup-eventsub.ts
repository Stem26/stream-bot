/**
 * Скрипт для ручной очистки EventSub подписок
 * Используй когда нужно удалить старые/зависшие подписки
 * 
 * Запуск: npm run eventsub:cleanup
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

const IS_LOCAL = process.env.NODE_ENV === 'development';
const envFile = IS_LOCAL ? '.env.local' : '.env';
const envPath = path.resolve(__dirname, '../../../../', envFile);

console.log(`[ENV] Загрузка конфигурации из: ${envPath}`);
dotenv.config({ path: envPath });

const TWITCH_ACCESS_TOKEN = process.env.TWITCH_ACCESS_TOKEN;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;

if (!TWITCH_ACCESS_TOKEN || !TWITCH_CLIENT_ID) {
    console.error('❌ Не заданы TWITCH_ACCESS_TOKEN или TWITCH_CLIENT_ID');
    process.exit(1);
}

async function cleanupEventSubSubscriptions() {
    try {
        console.log('🧹 Начинаем очистку EventSub подписок...\n');

        // Получаем список всех подписок
        const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
            headers: {
                'Authorization': `Bearer ${TWITCH_ACCESS_TOKEN}`,
                'Client-Id': TWITCH_CLIENT_ID
            }
        });

        if (!response.ok) {
            console.error(`❌ Ошибка получения списка подписок: ${response.status}`);
            return;
        }

        const data = await response.json() as { 
            data: Array<{ 
                id: string; 
                type: string; 
                status: string; 
                transport: { method: string };
                created_at: string;
            }>;
            total: number;
        };

        const subscriptions = data.data || [];
        console.log(`📋 Найдено подписок: ${data.total}\n`);

        if (subscriptions.length === 0) {
            console.log('✅ Нет подписок для удаления');
            return;
        }

        // Показываем все подписки
        subscriptions.forEach((sub, index) => {
            console.log(`${index + 1}. ${sub.type}`);
            console.log(`   ID: ${sub.id}`);
            console.log(`   Status: ${sub.status}`);
            console.log(`   Transport: ${sub.transport.method}`);
            console.log(`   Created: ${sub.created_at}`);
            console.log('');
        });

        // Удаляем все WebSocket подписки
        const websocketSubs = subscriptions.filter(sub => sub.transport.method === 'websocket');
        
        if (websocketSubs.length === 0) {
            console.log('✅ Нет WebSocket подписок для удаления');
            return;
        }

        console.log(`🗑️ Удаляем ${websocketSubs.length} WebSocket подписок...\n`);

        for (const sub of websocketSubs) {
            try {
                const deleteResponse = await fetch(
                    `https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`,
                    {
                        method: 'DELETE',
                        headers: {
                            'Authorization': `Bearer ${TWITCH_ACCESS_TOKEN}`,
                            'Client-Id': TWITCH_CLIENT_ID
                        }
                    }
                );

                if (deleteResponse.ok) {
                    console.log(`✅ Удалена: ${sub.type} (${sub.id})`);
                } else {
                    console.error(`❌ Ошибка удаления ${sub.type}: ${deleteResponse.status}`);
                }
            } catch (error) {
                console.error(`❌ Ошибка удаления подписки ${sub.id}:`, error);
            }
        }

        console.log('\n✅ Очистка завершена!');
    } catch (error) {
        console.error('❌ Ошибка при очистке подписок:', error);
        process.exit(1);
    }
}

cleanupEventSubSubscriptions();
