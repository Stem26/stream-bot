import {TwitchStreamMonitor} from '../services/twitch-stream-monitor';
import {NightBotMonitor} from '../services/nightbot-monitor';
import {AppConfig} from '../types/config';

/**
 * Подключает мониторинг Twitch стримов и чата
 */
export async function setupTwitch(
    streamMonitor: TwitchStreamMonitor,
    twitchChatMonitor: NightBotMonitor,
    config: AppConfig
): Promise<void> {
    if (!config.twitch) {
        console.log('⚠️ Twitch не настроен, пропускаем мониторинг');
        return;
    }

    const {channel, accessToken, clientId} = config.twitch;

    // Подключаемся к Twitch EventSub для мониторинга стримов
    console.log('🎬 Подключение к Twitch EventSub для мониторинга стримов...');
    await streamMonitor.connect(
        channel,
        accessToken,
        clientId,
        config.channelId
    );

    // Подключение к Twitch чату для обработки команд
    console.log('🎮 Подключение к Twitch чату для обработки команд...');

    twitchChatMonitor.onNightbotMessage = (channel, message, msg) => {
        console.log(`🤖 Nightbot в ${channel}: ${message}`);
    };

    await twitchChatMonitor.connect(
        channel,
        accessToken,
        clientId,
        config.nightbotToken
    );

    console.log('✅ Twitch интеграция настроена');
}
