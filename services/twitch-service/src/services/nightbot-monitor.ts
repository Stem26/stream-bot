import { ChatClient } from '@twurple/chat';
import { StaticAuthProvider } from '@twurple/auth';
import { processTwitchDickCommand } from '../commands/twitch-dick';
import { processTwitchTopDickCommand } from '../commands/twitch-topDick';
import { processTwitchBottomDickCommand } from '../commands/twitch-bottomDick';
import { processTwitchDuelCommand, enableDuels, disableDuels, pardonAllDuelTimeouts } from '../commands/twitch-duel';
import { processTwitchRatCommand, processTwitchCutieCommand, addActiveUser, setChattersAPIFunction } from '../commands/twitch-rat';
import { processTwitchPointsCommand, processTwitchTopPointsCommand } from '../commands/twitch-points';
import { ENABLE_BOT_FEATURES, ALLOW_LOCAL_COMMANDS } from '../config/features';
import { IS_LOCAL } from '../config/env';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/event-logger';

// Файл для хранения состояния счётчиков (в корне монорепы)
const COUNTERS_STATE_FILE = path.resolve(__dirname, '../../../../../counters-state.json');

interface CountersState {
    stopCounters: Record<string, number>;
    deathCounters: Record<string, number>;
}

/**
 * Загружает состояние счётчиков из файла
 */
function loadCountersState(): CountersState {
    try {
        if (fs.existsSync(COUNTERS_STATE_FILE)) {
            const data = fs.readFileSync(COUNTERS_STATE_FILE, 'utf-8');
            const parsed = JSON.parse(data);
            console.log('📋 Загружено состояние счётчиков:', parsed);
            return parsed;
        }
    } catch (error) {
        console.error('⚠️ Ошибка загрузки состояния счётчиков:', error);
    }
    return {stopCounters: {}, deathCounters: {}};
}

/**
 * Сохраняет состояние счётчиков в файл
 */
function saveCountersState(state: CountersState): void {
    try {
        fs.writeFileSync(COUNTERS_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (error) {
        console.error('⚠️ Ошибка сохранения состояния счётчиков:', error);
    }
}

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
    private syncViewersCallback: ((chattersCount?: number) => Promise<void>) | null = null;

    private dickQueue: Promise<void> = Promise.resolve();

    // Счётчик команды !стоп (username -> количество остановок)
    private stopCounters = new Map<string, number>();

    // Счётчик команды !смерть (username -> количество смертей в игре)
    private deathCounters = new Map<string, number>();

    // Кеш User ID для предотвращения повторных запросов к helix/users (username -> userId)
    // Критично для !vanish и !дуэль - без кеша каждый вызов = API запрос
    private userIdCache = new Map<string, string>();

    // Кеш списка зрителей чата (для команд !крыса, !милашка)
    private chattersCache = new Map<string, { users: string[]; expires: number; createdAt: number }>();
    private readonly CHATTERS_CACHE_TTL_MS = 60 * 1000; // 60 секунд
    // Inflight promise для предотвращения параллельных запросов к API
    private chattersFetchPromise: Promise<string[]> | null = null;
    // Периодический опрос chatters для синхронизации viewers (каждую минуту)
    private chattersSyncInterval: NodeJS.Timeout | null = null;
    private readonly CHATTERS_SYNC_INTERVAL_MS = 60 * 1000; // 60 секунд (синхронно с viewers)
    // Флаг для предотвращения параллельного запуска warmup
    private isWarmingUp: boolean = false;

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
        ['!стоп_дуэль', (ch, u, m, msg) => void this.handleDisableDuelsCommand(ch, u, msg)],
        ['!старт_дуэль', (ch, u, m, msg) => void this.handleEnableDuelsCommand(ch, u, msg)],
        ['!амнистия', (ch, u, m, msg) => void this.handleDuelPardonCommand(ch, u, msg)],
        ['!крыса', (ch, u, m, msg) => void this.handleRatCommand(ch, u, m, msg)],
        ['!милашка', (ch, u, m, msg) => void this.handleCutieCommand(ch, u, m, msg)],
        ['!vanish', (ch, u, m, msg) => void this.handleVanishCommand(ch, u, msg)],
        ['!стоп', (ch, u, m, msg) => void this.handleStopCommand(ch, u, msg)],
        ['!стопоткат', (ch, u, m, msg) => void this.handleStopRollbackCommand(ch, u, msg)],
        ['!стопсброс', (ch, u, m, msg) => void this.handleStopResetCommand(ch, u, msg)],
        ['!стопинфо', (ch, u, m, msg) => void this.handleStopInfoCommand(ch, u, msg)],
        ['!смерть', (ch, u, m, msg) => void this.handleDeathCommand(ch, u, msg)],
        ['!смертьоткат', (ch, u, m, msg) => void this.handleDeathRollbackCommand(ch, u, msg)],
        ['!смертьсброс', (ch, u, m, msg) => void this.handleDeathResetCommand(ch, u, msg)],
        ['!смертьинфо', (ch, u, m, msg) => void this.handleDeathInfoCommand(ch, u, msg)],
        ['!игры', (ch, u, m, msg) => void this.handleGamesCommand(ch, u, msg)],
        ['!help', (ch, u, m, msg) => void this.handleGamesCommand(ch, u, msg)]
    ]);

    constructor() {
        // Загружаем состояние счётчиков при создании
        const countersState = loadCountersState();

        // Восстанавливаем stopCounters из файла
        for (const [username, count] of Object.entries(countersState.stopCounters)) {
            this.stopCounters.set(username, count);
        }

        // Восстанавливаем deathCounters из файла
        for (const [username, count] of Object.entries(countersState.deathCounters)) {
            this.deathCounters.set(username, count);
        }

        console.log('📋 Загружены счётчики из файла:');
        console.log(`   !стоп: ${this.stopCounters.size} записей`);
        console.log(`   !смерть: ${this.deathCounters.size} записей`);
    }

    /**
     * Сохраняет текущее состояние счётчиков в файл
     */
    private saveCounters(): void {
        const state: CountersState = {
            stopCounters: Object.fromEntries(this.stopCounters),
            deathCounters: Object.fromEntries(this.deathCounters)
        };
        saveCountersState(state);
    }

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
                
                // КРИТИЧНО: 429 Rate Limit НЕ должен попадать в общий блок 4xx
                // 429 нужно ОБЯЗАТЕЛЬНО ретраить, иначе бот ломается при burst нагрузке
                if (status === 429) {
                    // Увеличенная задержка для rate limit: 3s, 6s, 9s...
                    // Критичные сценарии:
                    // - burst timeoutUser (20 !vanish подряд)
                    // - burst chatters pagination
                    // - burst users lookup (массовые дуэли)
                    const delayMs = 3000 * (attempt + 1);
                    console.log(`⛔ Rate limit Twitch (429), retry через ${delayMs}мс (попытка ${attempt + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }
                
                // Не делаем retry на остальных 4xx ошибках (клиентские ошибки, бессмысленно повторять)
                // ВАЖНО: status !== 429 явно исключает rate limit из этой проверки
                if (status && status >= 400 && status < 500 && status !== 429) {
                    throw lastError;
                }
                
                // Если это последняя попытка - пробрасываем ошибку
                if (attempt === maxRetries - 1) {
                    throw lastError;
                }

                // Exponential backoff для 5xx и network errors: 1s, 2s, 4s, 8s...
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

                // Синхронизируем viewers: опрашиваем оба API и берём максимальное значение
                // Это даёт самую точную оценку, так как разные API обновляются с разной скоростью
                if (this.syncViewersCallback) {
                    try {
                        await this.syncViewersCallback(filteredChatters.length);
                    } catch (error) {
                        console.error('⚠️ Ошибка синхронизации viewers:', error);
                    }
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
                headers: {'Authorization': `OAuth ${accessToken}`}
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
                
                // При переподключении перезапускаем синхронизацию зрителей если стрим онлайн
                if (this.isStreamOnlineCheck()) {
                    console.log('🔄 Переподключение к чату: проверяем синхронизацию зрителей...');
                    this.warmupChattersCache();
                }
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
            if (!ENABLE_BOT_FEATURES) {
                console.log('🔇 Все функции бота отключены (ENABLE_BOT_FEATURES=false) - только мониторинг');
            } else if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) {
                console.log('✅ Сообщения в чат включены (ENABLE_BOT_FEATURES=true)');
                console.log('🔒 Команды заблокированы локально (для теста: ALLOW_LOCAL_COMMANDS=true)');
            } else if (IS_LOCAL && ALLOW_LOCAL_COMMANDS) {
                console.log('⚠️⚠️⚠️ РЕЖИМ ТЕСТИРОВАНИЯ КОМАНД ЛОКАЛЬНО ⚠️⚠️⚠️');
                console.log('⚠️ УБЕДИСЬ ЧТО НА СЕРВЕРЕ ENABLE_BOT_FEATURES=false!');
                console.log('⚠️ Иначе команды будут дублироваться!');
            } else {
                console.log('✅ Функции бота включены (ENABLE_BOT_FEATURES=true)');
            }

            // Warming up: предзагружаем список зрителей для быстрого первого !крыса
            if (this.isStreamOnlineCheck()) {
                this.warmupChattersCache();
            }

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

                // Игнорировать команды если они отключены
                if (!ENABLE_BOT_FEATURES) {
                    if (this.commands.has(trimmedMessage)) {
                        console.log(`🔇 Команды отключены (ENABLE_BOT_FEATURES=false): ${trimmedMessage} не выполнена`);
                    }
                    return;
                }

                // Локально команды блокируются ПО УМОЛЧАНИЮ (защита от дублирования)
                // Для теста команд нужно явно включить ALLOW_LOCAL_COMMANDS=true
                if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) {
                    if (this.commands.has(trimmedMessage)) {
                        console.log(`🔒 Локально команды заблокированы (для теста добавь ALLOW_LOCAL_COMMANDS=true в .env.local)`);
                    }
                    return;
                }

                // Проверяем команду !стоп[число] (например: !стоп5, !стоп10)
                const stopWithNumberMatch = trimmedMessage.match(/^!стоп(\d+)$/);
                if (stopWithNumberMatch) {
                    const targetValue = parseInt(stopWithNumberMatch[1], 10);

                    // Проверка что стрим онлайн
                    if (!this.isStreamOnlineCheck() && !IS_LOCAL) {
                        console.log(`⚠️ Команда ${trimmedMessage} проигнорирована: стрим оффлайн`);
                        return;
                    }

                    if (IS_LOCAL && !this.isStreamOnlineCheck()) {
                        console.log(`🧪 ТЕСТ в оффлайне: выполняем команду ${trimmedMessage}`);
                    }

                    this.handleStopSetCommand(channel, user, targetValue, msg);
                    return;
                }

                // Проверяем команду !смерть[число] (например: !смерть5, !смерть10)
                const deathWithNumberMatch = trimmedMessage.match(/^!смерть(\d+)$/);
                if (deathWithNumberMatch) {
                    const targetValue = parseInt(deathWithNumberMatch[1], 10);

                    // Проверка что стрим онлайн
                    if (!this.isStreamOnlineCheck() && !IS_LOCAL) {
                        console.log(`⚠️ Команда ${trimmedMessage} проигнорирована: стрим оффлайн`);
                        return;
                    }

                    if (IS_LOCAL && !this.isStreamOnlineCheck()) {
                        console.log(`🧪 ТЕСТ в оффлайне: выполняем команду ${trimmedMessage}`);
                    }

                    this.handleDeathSetCommand(channel, user, targetValue, msg);
                    return;
                }

                // Проверяем, есть ли команда в мапе
                const commandHandler = this.commands.get(trimmedMessage);
                if (commandHandler) {
                    // Команды работают только когда стрим онлайн
                    // Локально можем тестировать и в оффлайне (если ENABLE_BOT_FEATURES=true)
                    if (!this.isStreamOnlineCheck() && !IS_LOCAL) {
                        console.log(`⚠️ Команда ${trimmedMessage} проигнорирована: стрим оффлайн`);
                        return;
                    }

                    // Локально показываем что тестируем в оффлайне
                    if (IS_LOCAL && !this.isStreamOnlineCheck()) {
                        console.log(`🧪 ТЕСТ в оффлайне: выполняем команду ${trimmedMessage}`);
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
                        const category = ircMessage.tags.get('msg-param-category');
                        const username = ircMessage.tags.get('login') || ircMessage.tags.get('display-name') || 'Unknown';
                        const displayName = ircMessage.tags.get('display-name') || username;
                        const value = ircMessage.tags.get('msg-param-value');

                        if (category === 'watch-streak') {
                            console.log(`🔥 Watch Streak! ${displayName} смотрит ${value}-й стрим подряд!`);

                            // Проверяем, включены ли функции бота
                            if (!ENABLE_BOT_FEATURES) {
                                console.log('🔇 Благодарности за watch streak отключены (ENABLE_BOT_FEATURES=false)');
                                return;
                            }

                            // Локально блокируем отправку (защита от дублирования с сервером)
                            if (IS_LOCAL && !ALLOW_LOCAL_COMMANDS) {
                                console.log('🔒 Локально благодарности за watch streak заблокированы (для теста добавь ALLOW_LOCAL_COMMANDS=true в .env.local)');
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

            console.log(`✅ NightBotMonitor подключен к каналу: ${this.channelName}`);
            log('CONNECTION', {
                service: 'NightBotMonitor',
                status: 'connected',
                channel: this.channelName
            });
            return true;
        } catch (error: any) {
            console.error('❌ Ошибка подключения к Twitch чату:', error);
            console.error('   Детали:', error?.message || 'нет деталей');
            log('ERROR', {
                context: 'NightBotMonitor.connect',
                error: error?.message || String(error),
                stack: error?.stack,
                channel: this.channelName
            });
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
        log('COMMAND', { command: '!дуэль', username: user, channel });

        try {
            const result = processTwitchDuelCommand(user, channel);

            // Если дуэли выключены, response будет пустым - ничего не отправляем
            if (result.response) {
                await this.sendMessage(channel, result.response);
                console.log(`✅ Отправлен ответ в чат: ${result.response}`);
            }

            // Логируем результат дуэли если она состоялась
            if (result.loser || result.bothLost) {
                const winner = result.bothLost ? undefined : (result.loser ? (result.loser === user ? result.loser2 || 'unknown' : user) : undefined);
                log('DUEL_RESULT', {
                    player1: result.loser || user,
                    player2: result.loser2 || user,
                    winner,
                    bothLost: result.bothLost,
                    outcome: result.bothLost ? 'both_lost' : winner ? `winner: ${winner}` : 'both_missed'
                });
            }

            // Если оба проиграли - даём таймаут обоим
            if (result.bothLost && result.loser && result.loser2) {
                await this.timeoutUser(result.loser, 300, 'Duel - Both Lost');
                await this.timeoutUser(result.loser2, 300, 'Duel - Both Lost');
            } else if (result.loser) {
                // Обычная дуэль - таймаут только проигравшему
                await this.timeoutUser(result.loser, 300, 'Duel');
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !дуэль:', error);
        }
    }

    /**
     * Обработка команды !стоп_дуэль из чата
     * Отключает дуэли (только для админов, без ответа в чат)
     */
    private async handleDisableDuelsCommand(channel: string, user: string, msg: any) {
        console.log(`🛑 Команда !стоп_дуэль от ${user} в ${channel}`);
        log('COMMAND', { command: '!стоп_дуэль', username: user, channel });

        try {
            disableDuels(user);
            // Ничего не отправляем в чат
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !стоп_дуэль:', error);
        }
    }

    /**
     * Обработка команды !старт_дуэль из чата
     * Включает дуэли (только для админов, без ответа в чат)
     */
    private async handleEnableDuelsCommand(channel: string, user: string, msg: any) {
        console.log(`✅ Команда !старт_дуэль от ${user} в ${channel}`);
        log('COMMAND', { command: '!старт_дуэль', username: user, channel });

        try {
            enableDuels(user);
            // Ничего не отправляем в чат
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !старт_дуэль:', error);
        }
    }

    /**
     * Обработка команды !амнистия (!дуэль_амнистия) из чата
     * Снимает таймауты дуэлей со всех игроков (только для админов)
     */
    private async handleDuelPardonCommand(channel: string, user: string, msg: any) {
        console.log(`🕊️ Команда !амнистия от ${user} в ${channel}`);

        try {
            const result = pardonAllDuelTimeouts(user);

            if (!result.success) {
                // Нет прав - игнорируем молча
                console.log(`⚠️ ${user} попытался использовать !амнистия без прав`);
                return;
            }

            // Логируем команду
            log('COMMAND', {
                command: '!амнистия',
                username: user,
                channel,
                pardonedCount: result.count
            });

            if (result.count > 0) {
                // Снимаем реальные таймауты в Twitch для всех игроков
                console.log(`🔓 Снимаем таймауты Twitch для ${result.usernames.length} игроков...`);
                let unbannedCount = 0;
                
                for (const username of result.usernames) {
                    const success = await this.untimeoutUser(username);
                    if (success) {
                        unbannedCount++;
                    }
                }

                console.log(`✅ Реальных таймаутов снято: ${unbannedCount}/${result.usernames.length}`);

                const response = `🕊️ Амнистия объявлена! Снято таймаутов: ${result.count}`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
            } else {
                const response = `ℹ️ Нет активных таймаутов дуэлей`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !амнистия:', error);
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
     * Обработка команды !стоп из чата
     * Увеличивает счётчик остановок стрима для kunilika666 (независимо от того, кто написал команду)
     */
    private async handleStopCommand(channel: string, user: string, msg: any) {
        console.log(`🛑 Команда !стоп от ${user} в ${channel}`);

        try {
            // Всегда считаем остановки для стримерши
            const streamerName = 'kunilika666';
            const currentCount = this.stopCounters.get(streamerName) || 0;
            const newCount = currentCount + 1;

            this.stopCounters.set(streamerName, newCount);
            this.saveCounters();

            // Формируем правильное окончание слова "раз"
            let razWord = 'раз';
            if (newCount % 10 === 1 && newCount % 100 !== 11) {
                razWord = 'раз';
            } else if ([2, 3, 4].includes(newCount % 10) && ![12, 13, 14].includes(newCount % 100)) {
                razWord = 'раза';
            } else {
                razWord = 'раз';
            }

            const response = `kunilika666 остановила стрим ${newCount} ${razWord}`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !стоп:', error);
        }
    }

    /**
     * Обработка команды !стоп[число] из чата (например: !стоп5, !стоп10)
     */
    private async handleStopSetCommand(channel: string, user: string, targetValue: number, msg: any) {
        console.log(`🎯 Команда !стоп${targetValue} от ${user} в ${channel}`);

        try {
            const streamerName = 'kunilika666';

            if (targetValue < 0 || targetValue > 9999) {
                const response = `Значение должно быть от 0 до 9999`;
                await this.sendMessage(channel, response);
                console.log(`⚠️ Некорректное значение: ${targetValue}`);
                return;
            }

            this.stopCounters.set(streamerName, targetValue);
            this.saveCounters();

            let razWord = 'раз';
            if (targetValue % 10 === 1 && targetValue % 100 !== 11) {
                razWord = 'раз';
            } else if ([2, 3, 4].includes(targetValue % 10) && ![12, 13, 14].includes(targetValue % 100)) {
                razWord = 'раза';
            } else {
                razWord = 'раз';
            }

            const response = `Счётчик установлен: kunilika666 остановила стрим ${targetValue} ${razWord}`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !стоп[число]:', error);
        }
    }

    /**
     * Обработка команды !стопоткат из чата
     * Уменьшает счётчик остановок стрима для kunilika666 (откат ошибочного нажатия)
     */
    private async handleStopRollbackCommand(channel: string, user: string, msg: any) {
        console.log(`↩️ Команда !стопоткат от ${user} в ${channel}`);

        try {
            // Всегда считаем остановки для стримерши
            const streamerName = 'kunilika666';
            const currentCount = this.stopCounters.get(streamerName) || 0;

            if (currentCount === 0) {
                const response = `Нет остановок для отката`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            const newCount = currentCount - 1;

            if (newCount === 0) {
                this.stopCounters.delete(streamerName);
            } else {
                this.stopCounters.set(streamerName, newCount);
            }
            this.saveCounters();

            // Формируем правильное окончание слова "раз"
            let razWord = 'раз';
            if (newCount % 10 === 1 && newCount % 100 !== 11) {
                razWord = 'раз';
            } else if ([2, 3, 4].includes(newCount % 10) && ![12, 13, 14].includes(newCount % 100)) {
                razWord = 'раза';
            } else {
                razWord = 'раз';
            }

            const response = newCount === 0
                ? `Откат выполнен, счётчик сброшен`
                : `Откат выполнен, kunilika666 остановила стрим ${newCount} ${razWord}`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !стопоткат:', error);
        }
    }

    /**
     * Обработка команды !стопсброс из чата
     * Полностью сбрасывает счётчик остановок для kunilika666
     */
    private async handleStopResetCommand(channel: string, user: string, msg: any) {
        console.log(`🔄 Команда !стопсброс от ${user} в ${channel}`);

        try {
            // Всегда считаем остановки для стримерши
            const streamerName = 'kunilika666';
            const currentCount = this.stopCounters.get(streamerName) || 0;

            if (currentCount === 0) {
                const response = `Счётчик остановок уже на нуле`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            this.stopCounters.delete(streamerName);
            this.saveCounters();

            const response = `Счётчик остановок сброшен`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !стопсброс:', error);
        }
    }

    /**
     * Обработка команды !стопинфо из чата
     * Показывает текущее количество остановок kunilika666
     */
    private async handleStopInfoCommand(channel: string, user: string, msg: any) {
        console.log(`ℹ️ Команда !стопинфо от ${user} в ${channel}`);

        try {
            // Всегда считаем остановки для стримерши
            const streamerName = 'kunilika666';
            const currentCount = this.stopCounters.get(streamerName) || 0;

            if (currentCount === 0) {
                const response = `kunilika666 ещё не останавливала стрим`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            // Формируем правильное окончание слова "раз"
            let razWord = 'раз';
            if (currentCount % 10 === 1 && currentCount % 100 !== 11) {
                razWord = 'раз';
            } else if ([2, 3, 4].includes(currentCount % 10) && ![12, 13, 14].includes(currentCount % 100)) {
                razWord = 'раза';
            } else {
                razWord = 'раз';
            }

            const response = `kunilika666 остановила стрим ${currentCount} ${razWord}`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !стопинфо:', error);
        }
    }

    /**
     * Обработка команды !смерть из чата
     * Увеличивает счётчик смертей в игре для kunilika666 (независимо от того, кто написал команду)
     */
    private async handleDeathCommand(channel: string, user: string, msg: any) {
        console.log(`💀 Команда !смерть от ${user} в ${channel}`);

        try {
            // Всегда считаем смерти для стримерши
            const streamerName = 'kunilika666';
            const currentCount = this.deathCounters.get(streamerName) || 0;
            const newCount = currentCount + 1;

            this.deathCounters.set(streamerName, newCount);
            this.saveCounters();

            // Формируем правильное окончание слова "раз"
            let razWord = 'раз';
            if (newCount % 10 === 1 && newCount % 100 !== 11) {
                razWord = 'раз';
            } else if ([2, 3, 4].includes(newCount % 10) && ![12, 13, 14].includes(newCount % 100)) {
                razWord = 'раза';
            } else {
                razWord = 'раз';
            }

            const response = `kunilika666 умерла ${newCount} ${razWord}`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !смерть:', error);
        }
    }

    /**
     * Обработка команды !смерть[число] из чата (например: !смерть5, !смерть10)
     */
    private async handleDeathSetCommand(channel: string, user: string, targetValue: number, msg: any) {
        console.log(`🎯 Команда !смерть${targetValue} от ${user} в ${channel}`);

        try {
            const streamerName = 'kunilika666';

            if (targetValue < 0 || targetValue > 9999) {
                const response = `Значение должно быть от 0 до 9999`;
                await this.sendMessage(channel, response);
                console.log(`⚠️ Некорректное значение: ${targetValue}`);
                return;
            }

            this.deathCounters.set(streamerName, targetValue);
            this.saveCounters();

            let razWord = 'раз';
            if (targetValue % 10 === 1 && targetValue % 100 !== 11) {
                razWord = 'раз';
            } else if ([2, 3, 4].includes(targetValue % 10) && ![12, 13, 14].includes(targetValue % 100)) {
                razWord = 'раза';
            } else {
                razWord = 'раз';
            }

            const response = `Счётчик установлен: kunilika666 умерла ${targetValue} ${razWord}`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !смерть[число]:', error);
        }
    }

    /**
     * Обработка команды !смертьоткат из чата
     * Уменьшает счётчик смертей для kunilika666 (откат ошибочного нажатия)
     */
    private async handleDeathRollbackCommand(channel: string, user: string, msg: any) {
        console.log(`↩️ Команда !смертьоткат от ${user} в ${channel}`);

        try {
            // Всегда считаем смерти для стримерши
            const streamerName = 'kunilika666';
            const currentCount = this.deathCounters.get(streamerName) || 0;

            if (currentCount === 0) {
                const response = `Нет смертей для отката`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            const newCount = currentCount - 1;

            if (newCount === 0) {
                this.deathCounters.delete(streamerName);
            } else {
                this.deathCounters.set(streamerName, newCount);
            }
            this.saveCounters();

            // Формируем правильное окончание слова "раз"
            let razWord = 'раз';
            if (newCount % 10 === 1 && newCount % 100 !== 11) {
                razWord = 'раз';
            } else if ([2, 3, 4].includes(newCount % 10) && ![12, 13, 14].includes(newCount % 100)) {
                razWord = 'раза';
            } else {
                razWord = 'раз';
            }

            const response = newCount === 0
                ? `Откат выполнен, счётчик сброшен`
                : `Откат выполнен, kunilika666 умерла ${newCount} ${razWord}`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !смертьоткат:', error);
        }
    }

    /**
     * Обработка команды !смертьсброс из чата
     * Полностью сбрасывает счётчик смертей для kunilika666
     */
    private async handleDeathResetCommand(channel: string, user: string, msg: any) {
        console.log(`🔄 Команда !смертьсброс от ${user} в ${channel}`);

        try {
            // Всегда считаем смерти для стримерши
            const streamerName = 'kunilika666';
            const currentCount = this.deathCounters.get(streamerName) || 0;

            if (currentCount === 0) {
                const response = `Счётчик смертей уже на нуле`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            this.deathCounters.delete(streamerName);
            this.saveCounters();

            const response = `Счётчик смертей сброшен`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !смертьсброс:', error);
        }
    }

    /**
     * Обработка команды !смертьинфо из чата
     * Показывает текущее количество смертей kunilika666
     */
    private async handleDeathInfoCommand(channel: string, user: string, msg: any) {
        console.log(`ℹ️ Команда !смертьинфо от ${user} в ${channel}`);

        try {
            // Всегда считаем смерти для стримерши
            const streamerName = 'kunilika666';
            const currentCount = this.deathCounters.get(streamerName) || 0;

            if (currentCount === 0) {
                const response = `kunilika666 ещё не умирала`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            // Формируем правильное окончание слова "раз"
            let razWord = 'раз';
            if (currentCount % 10 === 1 && currentCount % 100 !== 11) {
                razWord = 'раз';
            } else if ([2, 3, 4].includes(currentCount % 10) && ![12, 13, 14].includes(currentCount % 100)) {
                razWord = 'раза';
            } else {
                razWord = 'раз';
            }

            const response = `kunilika666 умерла ${currentCount} ${razWord}`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !смертьинфо:', error);
        }
    }

    /**
     * Обработка команды !vanish из чата
     * Даёт пользователю символический таймаут на 1 секунду для скрытия сообщений
     */
    private async handleVanishCommand(channel: string, user: string, msg: any) {
        console.log(`👻 Команда !vanish от ${user} в ${channel}`);

        // Импортируем STREAMER_USERNAME из config
        const {STREAMER_USERNAME} = require('../config/env');

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
     * Использует кеш User ID для предотвращения DDOS на helix/users
     */
    private async timeoutUser(username: string, durationSeconds: number, reason: string): Promise<void> {
        const normalizedUsername = username.toLowerCase();

        // Проверяем кеш User ID (уменьшает API нагрузку на ~90%)
        let userId = this.userIdCache.get(normalizedUsername);

        if (!userId) {
            // Кеш промах - запрашиваем у API
            const userData = await this.helix<{ data: Array<{ id: string }> }>(
                `https://api.twitch.tv/helix/users?login=${normalizedUsername}`
            );

            if (!userData.data[0]) {
                console.error(`❌ Пользователь ${username} не найден`);
                return;
            }

            userId = userData.data[0].id;
            this.userIdCache.set(normalizedUsername, userId);
            console.log(`📝 User ID закеширован: ${normalizedUsername} -> ${userId}`);
        }

        // Выдаём таймаут через Helix API
        await this.helix(
            `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${this.broadcasterId}&moderator_id=${this.moderatorId}`,
            {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    data: {user_id: userId, duration: durationSeconds, reason}
                })
            }
        );

        console.log(`✅ Таймаут выдан: ${username} на ${durationSeconds} сек.`);
    }

    /**
     * Снятие таймаута/бана с пользователя через Helix API
     * Использует кеш User ID для предотвращения DDOS на helix/users
     */
    private async untimeoutUser(username: string): Promise<boolean> {
        const normalizedUsername = username.toLowerCase();

        try {
            // Проверяем кеш User ID
            let userId = this.userIdCache.get(normalizedUsername);

            if (!userId) {
                // Кеш промах - запрашиваем у API
                const userData = await this.helix<{ data: Array<{ id: string }> }>(
                    `https://api.twitch.tv/helix/users?login=${normalizedUsername}`
                );

                if (!userData.data[0]) {
                    console.error(`❌ Пользователь ${username} не найден`);
                    return false;
                }

                userId = userData.data[0].id;
                this.userIdCache.set(normalizedUsername, userId);
                console.log(`📝 User ID закеширован: ${normalizedUsername} -> ${userId}`);
            }

            // Снимаем таймаут/бан через Helix API (DELETE запрос)
            await this.helix(
                `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${this.broadcasterId}&moderator_id=${this.moderatorId}&user_id=${userId}`,
                {
                    method: 'DELETE'
                }
            );

            console.log(`✅ Таймаут снят: ${username}`);
            return true;
        } catch (error: any) {
            console.error(`⚠️ Ошибка снятия таймаута ${username}:`, error?.message || error);
            return false;
        }
    }

    /**
     * Обработка команды !игры (!команды, !help) из чата
     * Отправляет список всех доступных команд
     */
    private async handleGamesCommand(channel: string, user: string, msg: any) {
        console.log(`📋 Команда !игры от ${user} в ${channel}`);

        const commandsList = [
            '!dick - вырастить письку',
            '!top_dick - топ самых длинных',
            '!bottom_dick - топ самых коротких',
            '!очки (!points) - проверить свои очки',
            '!топ_очки (!top_points) - топ по очкам',
            '!дуэль - (ставка 25 очков)',
            '!крыса - выбрать случайную крысу из чата',
            '!милашка - выбрать случайную милашку из чата',
            '!vanish - скрыть свои сообщения (1 сек таймаут)'
        ];

        const response = `📋 Доступные команды: ${commandsList.join(' • ')}`;

        try {
            await this.sendMessage(channel, response);
            console.log(`✅ Список команд отправлен в чат`);
        } catch (error) {
            console.error('❌ Ошибка при отправке списка команд:', error);
        }
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
    public onNightbotMessage: (channel: string, message: string, msg: any) => void = () => {
    };

    /**
     * Установить функцию проверки статуса стрима
     * @param checkFunction - функция, возвращающая true, если стрим онлайн
     */
    setStreamStatusCheck(checkFunction: () => boolean): void {
        this.isStreamOnlineCheck = checkFunction;
        console.log('✅ Установлена функция проверки статуса стрима');
    }

    /**
     * Устанавливает callback для синхронизации viewers при запросе chatters
     * @param callback - функция для синхронизированного запроса viewers (принимает количество chatters)
     */
    setSyncViewersCallback(callback: (chattersCount?: number) => Promise<void>): void {
        this.syncViewersCallback = callback;
        console.log('✅ Установлена функция синхронизации viewers');
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
     * Очистить счётчики команды !стоп (вызывается при окончании стрима)
     */
    clearStopCounters(): void {
        this.stopCounters.clear();
        this.saveCounters();
        console.log('🧹 Счётчики !стоп очищены и сохранены');
    }

    /**
     * Очистить счётчики команды !смерть (вызывается при окончании стрима)
     */
    clearDeathCounters(): void {
        this.deathCounters.clear();
        this.saveCounters();
        console.log('🧹 Счётчики !смерть очищены и сохранены');
    }

    /**
     * Warming up: предзагружает список зрителей в кеш для быстрого первого !крыса
     * Выполняется асинхронно в фоне, не блокирует запуск
     */
    private warmupChattersCache(): void {
        // Защита от параллельного запуска
        if (this.isWarmingUp) {
            console.log('⚠️ Warming up уже выполняется, пропускаем...');
            return;
        }

        // Если синхронизация уже запущена, просто перезапускаем интервал
        if (this.chattersSyncInterval) {
            console.log('♻️ Синхронизация уже запущена, обновляем интервал...');
            this.startChattersSyncInterval();
            return;
        }

        console.log('🔥 Warming up: предзагружаем список зрителей...');
        this.isWarmingUp = true;

        // Запускаем в фоне, не ждём результата
        this.getChatters(this.channelName)
            .then(chatters => {
                console.log(`✅ Warming up завершён: ${chatters.length} зрителей в кеше`);
                console.log(`👥 Зрители в кеше: ${chatters.join(', ')}`);

                // Запускаем периодический опрос для синхронизации viewers
                this.startChattersSyncInterval();
            })
            .catch(error => {
                console.log(`⚠️ Warming up не удался (не критично):`, error.message);
            })
            .finally(() => {
                this.isWarmingUp = false;
            });
    }

    /**
     * Публичный метод для запуска синхронизации зрителей (вызывается при начале стрима)
     */
    public startViewersSync(): void {
        console.log('🔄 Запуск синхронизации зрителей при начале стрима...');
        this.warmupChattersCache();
    }

    /**
     * Публичный метод для остановки синхронизации зрителей (вызывается при окончании стрима)
     */
    public stopViewersSync(): void {
        console.log('⏹️ Остановка синхронизации зрителей при окончании стрима...');
        this.stopChattersSyncInterval();
    }

    /**
     * Запускает периодический опрос chatters для синхронизации viewers
     * Опрашивает каждую минуту (синхронно с viewers API)
     * Результат: max(viewers API, chatters count) для максимальной точности пика
     */
    private startChattersSyncInterval(): void {
        // Останавливаем предыдущий интервал, если был
        if (this.chattersSyncInterval) {
            clearInterval(this.chattersSyncInterval);
        }

        console.log('🔄 Запущена периодическая синхронизация: каждую минуту опрашиваем оба API и берём max');

        this.chattersSyncInterval = setInterval(async () => {
            if (!this.isStreamOnlineCheck()) {
                return;
            }

            try {
                await this.getChatters(this.channelName);
            } catch (error) {
                console.error('⚠️ Ошибка периодического опроса chatters:', error);
            }
        }, this.CHATTERS_SYNC_INTERVAL_MS);
    }

    /**
     * Останавливает периодический опрос chatters
     */
    private stopChattersSyncInterval(): void {
        if (this.chattersSyncInterval) {
            clearInterval(this.chattersSyncInterval);
            this.chattersSyncInterval = null;
            console.log('⏹️ Остановлена периодическая синхронизация chatters');
        }
    }

    async disconnect() {
        if (this.chatClient) {
            await this.chatClient.quit();
            console.log('🔌 Отключено от Twitch чата');
            log('CONNECTION', {
                service: 'NightBotMonitor',
                status: 'disconnected',
                channel: this.channelName
            });
        }

        // Останавливаем периодический опрос
        this.stopChattersSyncInterval();

        // Очищаем кеш зрителей и inflight promise
        this.chattersCache.clear();
        this.chattersFetchPromise = null;

        // Очищаем кеш User ID
        if (this.userIdCache.size > 5000) {
            this.userIdCache.clear();
            console.log('🧹 Кеш User ID очищен');
        }
    }

    isConnected(): boolean {
        return this.chatClient !== null;
    }
}
