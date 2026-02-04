import { ChatClient } from '@twurple/chat';
import { StaticAuthProvider } from '@twurple/auth';
import { processTwitchDickCommand } from '../commands/twitch-dick';
import { processTwitchTopDickCommand } from '../commands/twitch-topDick';
import { processTwitchBottomDickCommand } from '../commands/twitch-bottomDick';
import { processTwitchDuelCommand } from '../commands/twitch-duel';
import { processTwitchRatCommand, addActiveUser } from '../commands/twitch-rat';
import { processTwitchPointsCommand, processTwitchTopPointsCommand } from '../commands/twitch-points';
import { IS_LOCAL } from '../config/env';

type CommandHandler = (channel: string, user: string, message: string, msg: any) => void | Promise<void>;

export class NightBotMonitor {
    private chatClient: ChatClient | null = null;
    private channelName: string = '';
    private broadcasterId: string = '';
    private moderatorId: string = '';
    private accessToken: string = '';
    private clientId: string = '';
    private isStreamOnlineCheck: () => boolean = () => true;

    private dickQueue: Promise<void> = Promise.resolve();

    // Мапа команд для чистого роутинга
    private readonly commands = new Map<string, CommandHandler>([
        ['!dick', (ch, u, m, msg) => {
            this.dickQueue = this.dickQueue
                .then(() => this.handleDickCommand(ch, u, m, msg))
                .catch(err => console.error('❌ dickQueue error:', err));
        }],
        ['!top_dick', (ch, u, m, msg) => void this.handleTopDickCommand(ch, u, m, msg)],
        ['!topdick', (ch, u, m, msg) => void this.handleTopDickCommand(ch, u, m, msg)],
        ['!bottom_dick', (ch, u, m, msg) => void this.handleBottomDickCommand(ch, u, m, msg)],
        ['!bottomdick', (ch, u, m, msg) => void this.handleBottomDickCommand(ch, u, m, msg)],
        ['!points', (ch, u, m, msg) => void this.handlePointsCommand(ch, u, m, msg)],
        ['!очки', (ch, u, m, msg) => void this.handlePointsCommand(ch, u, m, msg)],
        ['!top_points', (ch, u, m, msg) => void this.handleTopPointsCommand(ch, u, m, msg)],
        ['!toppoints', (ch, u, m, msg) => void this.handleTopPointsCommand(ch, u, m, msg)],
        ['!топ_очки', (ch, u, m, msg) => void this.handleTopPointsCommand(ch, u, m, msg)],
        ['!дуэль', (ch, u, m, msg) => void this.handleDuelCommand(ch, u, m, msg)],
        ['!крыса', (ch, u, m, msg) => void this.handleRatCommand(ch, u, m, msg)],
        ['!vanish', (ch, u, m, msg) => void this.handleVanishCommand(ch, u, msg)]
    ]);

    /**
     * Helper для Helix API запросов
     */
    private async helix<T>(url: string, options: RequestInit = {}): Promise<T> {
        const res = await fetch(url, {
            ...options,
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Client-Id': this.clientId,
                ...(options.headers || {})
            }
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
        }

        return (await res.json()) as T;
    }

    /**
     * Подключение к Twitch чату для мониторинга сообщений
     * @param channelName - имя канала
     * @param accessToken - OAuth токен для Twitch
     * @param clientId - Client ID приложения Twitch
     */
    async connect(channelName: string, accessToken: string, clientId: string) {
        try {
            this.channelName = channelName;
            this.accessToken = accessToken;
            this.clientId = clientId;

            console.log('🔄 Начинаем подключение к Twitch чату...');
            console.log('   Канал:', channelName);

            const authProvider = new StaticAuthProvider(clientId, accessToken);

            // Получаем broadcaster ID и moderator ID для команды !vanish
            const helixData = await this.helix<{ data: Array<{ id: string }> }>(
                `https://api.twitch.tv/helix/users?login=${channelName}`
            );
            
            if (!helixData.data[0]) {
                throw new Error(`Канал ${channelName} не найден в Helix`);
            }
            this.broadcasterId = helixData.data[0].id;

            const validateRes = await fetch('https://id.twitch.tv/oauth2/validate', {
                headers: { 'Authorization': `OAuth ${accessToken}` }
            });
            
            if (!validateRes.ok) {
                throw new Error(`Token validate failed: ${await validateRes.text()}`);
            }
            
            const validateData = await validateRes.json() as { user_id: string };
            this.moderatorId = validateData.user_id;

            this.chatClient = new ChatClient({
                authProvider,
                channels: [channelName]
            });

            this.chatClient.onConnect(() => {
                console.log('✅ Успешно подключились к Twitch чату!');
            });

            this.chatClient.onDisconnect((manually: boolean, reason?: Error) => {
                // Не логируем автоматические переподключения (код 1006)
                if (!manually && reason?.message?.includes('[1006]')) {
                    // Это нормальное автоматическое переподключение, игнорируем
                    return;
                }
                
                console.log('🔌 Отключились от Twitch чата');
                console.log('   Вручную:', manually);
                if (reason) {
                    console.log('   Причина:', reason.message);
                }
            });

            this.chatClient.onAuthenticationFailure((text: string, retryCount: number) => {
                console.error('❌ Ошибка аутентификации в Twitch:');
                console.error('   Сообщение:', text);
                console.error('   Попытка:', retryCount);
                console.error('   Проверьте, что ваш Access Token имеет права: chat:read и chat:edit');
            });

            await this.chatClient.connect();
            console.log(`✅ Подключено к чату канала: ${channelName}`);

            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log('✅ Чат готов к работе!');
            if (IS_LOCAL) {
                console.log('🧪 Локальный режим: команды чата отключены');
            }

            this.chatClient.onMessage((channel, user, message, msg) => {
                const username = user.toLowerCase();

                // Игнорируем сообщения от ботов (включая свои собственные)
                if (username === 'nightbot') {
                    this.handleNightbotMessage(channel, message, msg);
                    return;
                }

                // Игнорируем сообщения от своего бота
                if (username.includes('bot') || username === 'kunila666_bot') {
                    return;
                }

                // Отслеживаем активных пользователей для команды !крыса
                addActiveUser(channel, username);

                const trimmedMessage = message.trim().toLowerCase();
                console.log(`📨 ${user}: ${message}`);

                if (IS_LOCAL) {
                    return;
                }

                // Проверяем, есть ли команда в мапе
                const commandHandler = this.commands.get(trimmedMessage);
                if (commandHandler) {
                    // В dev режиме команды работают всегда, в prod только когда стрим онлайн
                    if (!IS_LOCAL && !this.isStreamOnlineCheck()) {
                        console.log(`⚠️ Команда ${trimmedMessage} проигнорирована: стрим оффлайн`);
                        return;
                    }
                    commandHandler(channel, user, message, msg);
                }
            });

            return true;
        } catch (error: any) {
            console.error('❌ Ошибка подключения к Twitch чату:', error);
            console.error('   Детали:', error?.message || 'нет деталей');
            return false;
        }
    }

    /**
     * Обработка команды !dick из чата
     */
    private async handleDickCommand(channel: string, user: string, message: string, msg: any) {
        console.log(`🎮 Команда !dick от ${user} в ${channel}`);

        try {
            const response = processTwitchDickCommand(user);
            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !dick:', error);
        }
    }

    /**
     * Обработка команды !top_dick из чата
     */
    private async handleTopDickCommand(channel: string, user: string, message: string, msg: any) {
        console.log(`🎮 Команда !top_dick от ${user} в ${channel}`);

        try {
            const response = processTwitchTopDickCommand();
            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен топ в чат`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !top_dick:', error);
        }
    }

    /**
     * Обработка команды !bottom_dick из чата
     */
    private async handleBottomDickCommand(channel: string, user: string, message: string, msg: any) {
        console.log(`🎮 Команда !bottom_dick от ${user} в ${channel}`);

        try {
            const response = processTwitchBottomDickCommand();
            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен антитоп в чат`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !bottom_dick:', error);
        }
    }

    /**
     * Обработка команды !points из чата
     */
    private async handlePointsCommand(channel: string, user: string, message: string, msg: any) {
        console.log(`💰 Команда !points от ${user} в ${channel}`);

        try {
            const response = processTwitchPointsCommand(user);
            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !points:', error);
        }
    }

    /**
     * Обработка команды !top_points из чата
     */
    private async handleTopPointsCommand(channel: string, user: string, message: string, msg: any) {
        console.log(`💰 Команда !top_points от ${user} в ${channel}`);

        try {
            const response = processTwitchTopPointsCommand();
            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен топ по очкам в чат`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !top_points:', error);
        }
    }

    /**
     * Обработка команды !дуэль из чата
     */
    private async handleDuelCommand(channel: string, user: string, message: string, msg: any) {
        console.log(`⚔️ Команда !дуэль от ${user} в ${channel}`);

        try {
            const result = processTwitchDuelCommand(user, channel);
            await this.sendMessage(channel, result.response);
            console.log(`✅ Отправлен ответ в чат: ${result.response}`);

            if (result.loser) {
                await this.timeoutUser(result.loser, 300, 'Duel');
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !дуэль:', error);
        }
    }

    /**
     * Обработка команды !крыса из чата
     * Выбирает рандомного активного чатера
     */
    private async handleRatCommand(channel: string, user: string, message: string, msg: any) {
        console.log(`🐀 Команда !крыса от ${user} в ${channel}`);

        try {
            const result = processTwitchRatCommand(channel);
            await this.sendMessage(channel, result.response);
            console.log(`✅ Отправлен ответ в чат: ${result.response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !крыса:', error);
        }
    }

    /**
     * Обработка команды !vanish из чата
     * Даёт пользователю символический таймаут на 1 секунду для скрытия сообщений
     */
    private async handleVanishCommand(channel: string, user: string, msg: any) {
        console.log(`👻 Команда !vanish от ${user} в ${channel}`);
        
        try {
            await this.timeoutUser(user, 1, 'Vanish');
        } catch (error: any) {
            console.error(`❌ Ошибка !vanish:`, error?.message || error);
        }
    }

    /**
     * Таймаут пользователя через Helix API
     */
    private async timeoutUser(username: string, durationSeconds: number, reason: string): Promise<void> {
        // Получаем ID пользователя
        const userData = await this.helix<{ data: Array<{ id: string }> }>(
            `https://api.twitch.tv/helix/users?login=${username.toLowerCase()}`
        );
        if (!userData.data[0]) {
            console.error(`❌ Пользователь ${username} не найден`);
            return;
        }
        const userId = userData.data[0].id;

        // Выдаём таймаут через Helix API
        await this.helix(
            `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${this.broadcasterId}&moderator_id=${this.moderatorId}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    data: { user_id: userId, duration: durationSeconds, reason }
                })
            }
        );

        console.log(`✅ Таймаут выдан: ${username} на ${durationSeconds} сек.`);
    }

    /**
     * Отправка сообщения в чат Twitch
     * Использует прямую отправку через Chat Client (с токеном модератора)
     * Nightbot API используется только как fallback, если прямая отправка не удалась
     */
    async sendMessage(channel: string, message: string): Promise<void> {
        if (!this.chatClient) {
            console.error('❌ Chat client не подключен');
            throw new Error('Chat client не подключен');
        }

        // Основной способ: прямая отправка через Chat Client с токеном модератора
        try {
            await this.chatClient.say(channel, message);
            return;
        } catch (error: any) {
            console.error('❌ Ошибка прямой отправки сообщения:');
            console.error('   Канал:', channel);
            console.error('   Сообщение:', message);
            console.error('   Ошибка:', error?.message || 'нет деталей');

            throw error;
        }
    }

    /**
     * Обработчик сообщений от Nightbot
     */
    private handleNightbotMessage(channel: string, message: string, msg: any) {
        if (message.includes('!song')) {
            this.handleSongRequest(message);
        }

        if (message.includes('has been timed out')) {
            this.handleTimeout(message);
        }

        if (message.startsWith('[Timer]')) {
            this.handleTimer(message);
        }

        this.onNightbotMessage(channel, message, msg);
    }

    private handleSongRequest(message: string) {
        console.log('🎵 Song Request:', message);
    }

    private handleTimeout(message: string) {
        console.log('⏱️ Timeout:', message);
    }

    private handleTimer(message: string) {
        console.log('⏰ Timer:', message);
    }

    /**
     * Callback для обработки сообщений Nightbot (можно переопределить)
     */
    public onNightbotMessage: (channel: string, message: string, msg: any) => void = () => {};

    /**
     * Установить функцию проверки статуса стрима
     * @param checkFunction - функция, возвращающая true, если стрим онлайн
     */
    setStreamStatusCheck(checkFunction: () => boolean): void {
        this.isStreamOnlineCheck = checkFunction;
        console.log('✅ Установлена функция проверки статуса стрима');
    }


    async disconnect() {
        if (this.chatClient) {
            await this.chatClient.quit();
            console.log('🔌 Отключено от Twitch чата');
        }
    }

    isConnected(): boolean {
        return this.chatClient !== null;
    }
}
