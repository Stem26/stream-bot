import type { Telegram } from 'telegraf';
import type {
    TwitchEventSubStreamOfflineEvent,
    TwitchEventSubStreamOnlineEvent
} from './twitch-eventsub.types';

type StreamData = {
    game_name?: string | null;
    title: string;
};

type StreamOfflineStats = {
    peak: number;
    duration: string;
    followsCount: number;
};

type StreamOnlineEvent = Pick<
    TwitchEventSubStreamOnlineEvent,
    'broadcaster_user_name' | 'broadcaster_user_login'
>;

type StreamOfflineEvent = TwitchEventSubStreamOfflineEvent;

// ===== Telegram Transport =====
export class TelegramSender {
    constructor(private readonly telegram: Telegram) { }

    async sendMessage(chatId: string, message: string, options?: any): Promise<any> {
        return this.telegram.sendMessage(chatId, message, options);
    }
}

// ===== Telegram Presentation =====
export class TelegramMessageBuilder {
    buildStreamOnlineMessage(input: {
        event: StreamOnlineEvent;
        stream?: StreamData | null;
    }): string {
        const { event, stream } = input;
        if (stream) {
            return `
🟢 <b>Стрим начался!</b>

<b>Канал:</b> ${event.broadcaster_user_name}
<b>Категория:</b> ${stream.game_name || 'Не указана'}
<b>Название:</b> ${stream.title}

🔗 <a href="https://twitch.tv/${event.broadcaster_user_login}">${event.broadcaster_user_name}</a>
                `.trim();
        }

        return `
🟢 <b>Стрим начался!</b>

<b>Канал:</b> ${event.broadcaster_user_name}

🔗 <a href="https://twitch.tv/${event.broadcaster_user_login}">${event.broadcaster_user_name}</a>
                `.trim();
    }

    buildStreamOfflineMessage(input: {
        event: StreamOfflineEvent;
        stats: StreamOfflineStats;
    }): string {
        const { event, stats } = input;
        return [
            `🔴 Стрим <a href="https://twitch.tv/${event.broadcaster_user_login}">${event.broadcaster_user_name}</a> закончился`,
            ``,
            `   <b>Максимум зрителей:</b> ${stats.peak}`,
            `   <b>Продолжительность:</b> ${stats.duration}`,
            `   <b>Новых follow:</b> ${stats.followsCount}`
        ].join('\n');
    }
}
