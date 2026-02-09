import { ChatClient } from '@twurple/chat';
import { StaticAuthProvider } from '@twurple/auth';
import { processTwitchDickCommand } from '../commands/twitch-dick';
import { processTwitchTopDickCommand } from '../commands/twitch-topDick';
import { processTwitchBottomDickCommand } from '../commands/twitch-bottomDick';
import { processTwitchDuelCommand } from '../commands/twitch-duel';
import { processTwitchRatCommand, processTwitchCutieCommand, addActiveUser, setChattersAPIFunction } from '../commands/twitch-rat';
import { processTwitchPointsCommand, processTwitchTopPointsCommand } from '../commands/twitch-points';
import { ENABLE_CHAT_COMMANDS, ENABLE_WATCH_STREAK_MESSAGES } from '../config/features';

type CommandHandler = (channel: string, user: string, message: string, msg: any) => void | Promise<void>;

// Blacklist ботов для фильтрации из списка зрителей (нормализован в lowercase + Set для O(1) поиска)
const BOT_BLACKLIST = new Set([
    'nightbot',
    'streamelements',
    'streamlabs',
    'moobot',
    'fossabot',
    'wizebot',
    'botrix',
    'coebot',
    'vivbot',
    'ankhbot',
    'deepbot',
    'streamjar',
    'pretzelrocks',
    'sery_bot',
    'stay_hydrated_bot',
    'commanderroot',
    'virgoproz',
    'p0sitivitybot',
    'soundalerts',
    'slocool'
].map(x => x.toLowerCase()));

export class NightBotMonitor {
    private chatClient: ChatClient | null = null;
    private channelName: string = '';
    private broadcasterId: string = '';
    private moderatorId: string = '';
    private accessToken: string = '';
    private clientId: string = '';
    private isStreamOnlineCheck: () => boolean = () => true;

    private dickQueue: Promise<void> = Promise.resolve();

    // Кеш списка зрителей чата (для команд !крыса, !милашка)
    private chattersCache = new Map<string, { users: string[]; expires: number; createdAt: number }>();
    private readonly CHATTERS_CACHE_TTL_MS = 60 * 1000; // 60 секунд
    // Inflight promise для предотвращения параллельных запросов к API
    private chattersFetchPromise: Promise<string[]> | null = null;

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
        ['!милашка', (ch, u, m, msg) => void this.handleCutieCommand(ch, u, m, msg)],
        ['!vanish', (ch, u, m, msg) => void this.handleVanishCommand(ch, u, msg)]
    ]);

    /**
     * Helper для Helix API запросов с retry логикой (exponential backoff)
     * @param url - URL для запроса
     * @param options - fetch options
     * @param maxRetries - максимальное количество попыток (по умолчанию 3)
     */
    private async helix<T>(url: string, options: RequestInit = {}, maxRetries: number = 3): Promise<T> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
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
                    const error = new Error(`HTTP ${res.status}: ${text}`);
                    (error as any).status = res.status;
                    throw error;
                }

                return (await res.json()) as T;

            } catch (error) {
                lastError = error as Error;
                const status = (error as any).status;
                
                // Не делаем retry на 4xx ошибках (клиентские ошибки, бессмысленно повторять)
                if (status && status >= 400 && status < 500) {
                    throw lastError;
                }
                
                // Если это последняя попытка - пробрасываем ошибку
                if (attempt === maxRetries - 1) {
                    throw lastError;
                }

                // Exponential backoff: 1s, 2s, 4s, 8s...
                const delayMs = 1000 * Math.pow(2, attempt);
                console.log(`⚠️ Helix API ошибка (попытка ${attempt + 1}/${maxRetries}), повтор через ${delayMs}мс:`, lastError.message);
                
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        // Этот код никогда не выполнится, но TypeScript требует
        throw lastError!;
    }

    /**
     * Получить список всех зрителей подключенных к чату
     * Обрабатывает пагинацию для получения всех пользователей (API лимит: 1000 за запрос)
     * Использует кеширование для снижения нагрузки на Twitch API
     * Использует inflight promise для предотвращения параллельных запросов
     * Использует Stale-While-Revalidate: при ошибке API возвращает устаревший кеш
     */
    private async getChatters(channel: string): Promise<string[]> {
        const normalized = channel.replace(/^#/, '').toLowerCase();
        const now = Date.now();

        // Проверяем свежий кеш
        const cached = this.chattersCache.get(normalized);
        if (cached && cached.expires > now) {
            console.log(`📦 Используем кеш зрителей: ${cached.users.length} пользователей (свежесть: ${Math.round((cached.expires - now) / 1000)}с)`);
            return cached.users;
        }

        // Если запрос уже в процессе - ждём его результата (race condition protection)
        if (this.chattersFetchPromise) {
            console.log(`⏳ Запрос к API уже в процессе, ожидаем...`);
            return this.chattersFetchPromise;
        }

        // Создаём новый запрос и сохраняем promise
        this.chattersFetchPromise = (async () => {
            try {
                let cursor: string | undefined;
                const allChatters: string[] = [];
                let pageCount = 0;
                const MAX_PAGES = 50; // Safety limit: 50 страниц × 1000 = 50,000 зрителей максимум

                do {
                    const url = new URL('https://api.twitch.tv/helix/chat/chatters');
                    url.searchParams.set('broadcaster_id', this.broadcasterId);
                    url.searchParams.set('moderator_id', this.moderatorId);
                    url.searchParams.set('first', '1000');

                    if (cursor) {
                        url.searchParams.set('after', cursor);
                    }

                    const response = await this.helix<{
                        data: Array<{ user_login: string }>;
                        pagination?: { cursor?: string };
                        total: number;
                    }>(url.toString());

                    const pageChatters = response.data.map(c => c.user_login);
                    allChatters.push(...pageChatters);
                    cursor = response.pagination?.cursor;
                    pageCount++;

                    console.log(`📊 Страница ${pageCount}: получено ${pageChatters.length} зрителей (всего: ${allChatters.length})`);

                    // Safety limit: защита от бесконечного цикла при баге pagination
                    if (pageCount >= MAX_PAGES) {
                        console.warn(`⚠️ Достигнут лимит страниц (${MAX_PAGES}), прерываем pagination`);
                        break;
                    }

                } while (cursor);

                console.log(`✅ Получено ${allChatters.length} зрителей из Twitch API за ${pageCount} запросов`);

                // Фильтруем ботов (Set.has() = O(1) vs Array.includes() = O(n))
                const filteredBots = allChatters.filter(user => BOT_BLACKLIST.has(user.toLowerCase()));
                const filteredChatters = allChatters.filter(user => !BOT_BLACKLIST.has(user.toLowerCase()));
                const botsFiltered = allChatters.length - filteredChatters.length;

                if (botsFiltered > 0) {
                    console.log(`🤖 Отфильтровано ботов: ${botsFiltered} (${filteredBots.join(', ')}) - осталось: ${filteredChatters.length} зрителей`);
                }

                // Сохраняем в кеш с timestamp создания
                this.chattersCache.set(normalized, {
                    users: filteredChatters,
                    expires: now + this.CHATTERS_CACHE_TTL_MS,
                    createdAt: now
                });

                return filteredChatters;
            } catch (error) {
                console.error('❌ Ошибка получения списка зрителей:', error);
                
                // Stale-While-Revalidate: если API упал, используем старый кеш (даже истёкший)
                const staleCache = this.chattersCache.get(normalized);
                if (staleCache) {
                    const staleAge = Math.round((now - staleCache.createdAt) / 1000);
                    console.log(`⚠️ API недоступен, используем устаревший кеш: ${staleCache.users.length} пользователей (возраст: ${staleAge}с)`);
                    return staleCache.users;
                }
                
                // Только если кеша вообще нет - пробрасываем ошибку для fallback на activeUsers
                console.error('❌ Кеш отсутствует, fallback на activeUsers');
                throw error;
            } finally {
                // Очищаем inflight promise после завершения (успешного или с ошибкой)
                this.chattersFetchPromise = null;
            }
        })();

        return this.chattersFetchPromise;
    }

    /**
     * Подключение к Twitch чату для мониторинга сообщений
     * @param channelName - имя канала
     * @param accessToken - OAuth токен для Twitch
     * @param clientId - Client ID приложения Twitch
     */
    async connect(channelName: string, accessToken: string, clientId: string) {
        try {
            // Нормализуем имя канала сразу (убираем # и приводим к lowercase)
            this.channelName = channelName.replace(/^#/, '').toLowerCase();
            this.accessToken = accessToken;
            this.clientId = clientId;

            console.log('🔄 Начинаем подключение к Twitch чату...');
            console.log('   Канал:', this.channelName);

            const authProvider = new StaticAuthProvider(clientId, accessToken);

            // Получаем broadcaster ID и moderator ID для команды !vanish
            const helixData = await this.helix<{ data: Array<{ id: string }> }>(
                `https://api.twitch.tv/helix/users?login=${this.channelName}`
            );

            if (!helixData.data[0]) {
                throw new Error(`Канал ${this.channelName} не найден в Helix`);
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

            // Устанавливаем функцию для получения списка зрителей
            setChattersAPIFunction((channel: string) => this.getChatters(channel));

            this.chatClient = new ChatClient({
                authProvider,
                channels: [this.channelName]
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
            console.log(`✅ Подключено к чату канала: ${this.channelName}`);

            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log('✅ Чат готов к работе!');
            if (!ENABLE_CHAT_COMMANDS) {
                console.log('🧪 Команды чата отключены (ENABLE_CHAT_COMMANDS=false)');
            }

            // Warming up: предзагружаем список зрителей для быстрого первого !крыса
            this.warmupChattersCache();

            this.chatClient.onMessage((channel, user, message, msg) => {
                const username = user.toLowerCase();

                // Игнорируем сообщения от ботов (включая свои собственные)
                if (username === 'nightbot') {
                    this.handleNightbotMessage(channel, message, msg);
                    return;
                }

                // Игнорируем сообщения от ботов из blacklist
                if (BOT_BLACKLIST.has(username)) {
                    return;
                }

                // Отслеживаем активных пользователей для команды !крыса (fallback)
                addActiveUser(channel, username);

                const trimmedMessage = message.trim().toLowerCase();
                console.log(`📨 ${user}: ${message}`);

                //Игнорировать команды если они отключены
                if (!ENABLE_CHAT_COMMANDS) {
                    return;
                }

                // Проверяем, есть ли команда в мапе
                const commandHandler = this.commands.get(trimmedMessage);
                if (commandHandler) {
                    // Команды работают только когда стрим онлайн
                    if (!this.isStreamOnlineCheck()) {
                        console.log(`⚠️ Команда ${trimmedMessage} проигнорирована: стрим оффлайн`);
                        return;
                    }
                    commandHandler(channel, user, message, msg);
                }
            });

            // Отслеживаем ритуалы (первое сообщение нового зрителя)
            this.chatClient.onRitual((channel, user, ritualInfo, msg) => {
                console.log(`🎉 Ritual событие: ${ritualInfo.ritualName} от ${user}`);
                
                if (ritualInfo.ritualName === 'new_chatter') {
                    console.log(`👋 Новый зритель: ${user} - ${ritualInfo.message || ''}`);
                }
            });

            // Отслеживаем серии просмотров (watch streaks) через низкоуровневый IRC
            // @twurple пока не имеет специального обработчика для viewermilestone
            this.chatClient.irc.onAnyMessage((ircMessage) => {
                if (ircMessage.command === 'USERNOTICE') {
                    const msgId = ircMessage.tags.get('msg-id');
                    
                    if (msgId === 'viewermilestone') {
                        console.log('🎯 VIEWERMILESTONE событие обнаружено!');
                        console.log('='.repeat(80));
                        
                        // Полный дамп всего объекта ircMessage
                        console.log('📦 ПОЛНЫЙ ОБЪЕКТ ircMessage:');
                        
                        // 1. Выводим все ключи объекта
                        console.log('🔑 Ключи объекта:', Object.keys(ircMessage));
                        console.log('🔑 Все свойства:', Object.getOwnPropertyNames(ircMessage));
                        
                        // 2. console.dir для глубокого просмотра
                        console.log('🔍 Глубокий просмотр объекта:');
                        console.dir(ircMessage, { depth: null, colors: true });
                        
                        // 3. Пытаемся сериализовать в JSON
                        try {
                            console.log('📋 JSON представление:');
                            console.log(JSON.stringify({
                                command: ircMessage.command,
                                prefix: ircMessage.prefix,
                                tags: Object.fromEntries(ircMessage.tags.entries()),
                            }, null, 2));
                        } catch (e) {
                            console.log('⚠️ Не удалось сериализовать в JSON:', e);
                        }
                        
                        console.log('='.repeat(80));
                        
                        const category = ircMessage.tags.get('msg-param-category');
                        const username = ircMessage.tags.get('login') || ircMessage.tags.get('display-name') || 'Unknown';
                        const displayName = ircMessage.tags.get('display-name') || username;
                        const value = ircMessage.tags.get('msg-param-value');
                        const systemMsg = ircMessage.tags.get('system-msg')?.replace(/\\s/g, ' ') || '';
                        
                        console.log(`👤 Пользователь: ${username}`);
                        console.log(`📊 Категория: ${category}`);
                        console.log(`🔢 Значение: ${value}`);
                        console.log(`💬 Системное сообщение: ${systemMsg}`);
                        
                        if (category === 'watch-streak') {
                            console.log(`🔥 Watch Streak! ${username} смотрит ${value}-й стрим подряд!`);
                            
                            // Проверяем, включена ли функция благодарностей за watch streak
                            if (!ENABLE_WATCH_STREAK_MESSAGES) {
                                console.log('⚠️ Благодарности за watch streak отключены (ENABLE_WATCH_STREAK_MESSAGES=false)');
                                return;
                            }
                            
                            // Отправляем благодарность в чат
                            const channel = (ircMessage as any).channel;
                            if (channel && value) {
                                this.sendMessage(channel, `${displayName} спасибо за ${value} подряд ❤️`).catch(err => {
                                    console.error('Ошибка отправки сообщения о watch streak:', err);
                                });
                            } else {
                                console.error('⚠️ Не удалось определить канал или значение из ircMessage');
                            }
                        }
                        
                        console.log('='.repeat(80));
                    }
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
     * Выбирает рандомного активного чатера из списка подключенных зрителей
     */
    private async handleRatCommand(channel: string, user: string, message: string, msg: any) {
        console.log(`🐀 Команда !крыса от ${user} в ${channel}`);

        try {
            const result = await processTwitchRatCommand(channel, user);
            await this.sendMessage(channel, result.response);
            console.log(`✅ Отправлен ответ в чат: ${result.response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !крыса:', error);
        }
    }

    /**
     * Обработка команды !милашка из чата
     * Выбирает рандомного активного чатера из списка подключенных зрителей
     */
    private async handleCutieCommand(channel: string, user: string, message: string, msg: any) {
        console.log(`💕 Команда !милашка от ${user} в ${channel}`);

        try {
            const result = await processTwitchCutieCommand(channel, user);
            await this.sendMessage(channel, result.response);
            console.log(`✅ Отправлен ответ в чат: ${result.response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !милашка:', error);
        }
    }

    /**
     * Обработка команды !vanish из чата
     * Даёт пользователю символический таймаут на 1 секунду для скрытия сообщений
     */
    private async handleVanishCommand(channel: string, user: string, msg: any) {
        console.log(`👻 Команда !vanish от ${user} в ${channel}`);

        // Импортируем STREAMER_USERNAME из config
        const { STREAMER_USERNAME } = require('../config/env');
        
        // Стример не может банить сам себя
        if (STREAMER_USERNAME && user.toLowerCase() === STREAMER_USERNAME.toLowerCase()) {
            console.log(`⚠️ Стример ${user} попытался использовать !vanish - игнорируем`);
            return;
        }

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
     */
    async sendMessage(channel: string, message: string): Promise<void> {
        if (!this.chatClient) {
            console.error('❌ Chat client не подключен');
            throw new Error('Chat client не подключен');
        }

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

    /**
     * Очистить кеш зрителей чата (полезно при окончании стрима)
     */
    clearChattersCache(): void {
        this.chattersCache.clear();
        this.chattersFetchPromise = null;
        console.log('🧹 Кеш зрителей очищен');
    }

    /**
     * Warming up: предзагружает список зрителей в кеш для быстрого первого !крыса
     * Выполняется асинхронно в фоне, не блокирует запуск
     */
    private warmupChattersCache(): void {
        console.log('🔥 Warming up: предзагружаем список зрителей...');
        
        // Запускаем в фоне, не ждём результата
        this.getChatters(this.channelName)
            .then(chatters => {
                console.log(`✅ Warming up завершён: ${chatters.length} зрителей в кеше`);
                console.log(`👥 Зрители в кеше: ${chatters.join(', ')}`); //узнать какие зрители подключены
            })
            .catch(error => {
                console.log(`⚠️ Warming up не удался (не критично):`, error.message);
            });
    }

    async disconnect() {
        if (this.chatClient) {
            await this.chatClient.quit();
            console.log('🔌 Отключено от Twitch чата');
        }

        // Очищаем кеш зрителей и inflight promise
        this.chattersCache.clear();
        this.chattersFetchPromise = null;
    }

    isConnected(): boolean {
        return this.chatClient !== null;
    }
}
