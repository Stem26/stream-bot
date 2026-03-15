import { ChatClient } from '@twurple/chat';
import { StaticAuthProvider } from '@twurple/auth';
import { processTwitchDickCommand } from '../commands/twitch-dick';
import { processTwitchTopDickCommand } from '../commands/twitch-topDick';
import { processTwitchBottomDickCommand } from '../commands/twitch-bottomDick';
import { processTwitchDuelCommand, enableDuels, disableDuels, pardonAllDuelTimeouts, enableDuelsFromWeb as enableDuelsFromWebApi, disableDuelsFromWeb as disableDuelsFromWebApi, pardonAllDuelTimeoutsFromWeb, getDuelBannedPlayersFromWeb, pardonDuelUserFromWeb, getDuelCooldownSkipped, setDuelCooldownSkipped, getDuelTimeoutSeconds, acceptDuelChallenge, declineDuelChallenge, clearDuelChallenges, setDuelAdminsFromModerators, areDuelsEnabled } from '../commands/twitch-duel';
import { processTwitchRatCommand, processTwitchCutieCommand, addActiveUser, setChattersAPIFunction } from '../commands/twitch-rat';
import { processTwitchPointsCommand, processTwitchTopPointsCommand } from '../commands/twitch-points';
import { ENABLE_BOT_FEATURES, ALLOW_LOCAL_COMMANDS } from '../config/features';
import { IS_LOCAL } from '../config/env';
import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne } from '../database/database';
import { log } from '../utils/event-logger';
import {
    fetchOverlayCharacters,
    setOverlayPlayerCharacter,
    triggerOverlayPlayer,
    amnestyOverlayPlayer,
    jumpOverlayPlayer,
} from './overlay-api';

// Файл для хранения состояния счётчиков (в корне монорепы)
const COUNTERS_STATE_FILE = path.resolve(__dirname, '../../../../../counters-state.json');

// Файл для хранения кастомных команд (если понадобится fallback)
const DATA_DIR = (() => {
    const fromModule = path.resolve(__dirname, '..', 'data');
    if (fs.existsSync(fromModule)) return fromModule;
    return path.resolve(process.cwd(), 'src/data');
})();
const CUSTOM_COMMANDS_FILE = path.join(DATA_DIR, 'custom-commands.json');

interface CountersState {
    stopCounters: Record<string, number>;
    deathCounters: Record<string, number>;
}

interface LinksConfig {
    allLinksText: string;
}

interface CustomCommand {
    id: string;
    trigger: string;
    aliases: string[];
    response: string;
    enabled: boolean;
    cooldown: number;
    messageType: 'announcement' | 'message';
    color: 'primary' | 'blue' | 'green' | 'orange' | 'purple';
    description: string;
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

async function loadLinksConfigFromDb(): Promise<LinksConfig> {
    try {
        const row = await queryOne<{ all_links_text: string }>('SELECT all_links_text FROM links_config WHERE id = 1');
        return { allLinksText: row?.all_links_text ?? '' };
    } catch (error) {
        console.error('⚠️ Ошибка загрузки links_config из БД:', error);
        return { allLinksText: '' };
    }
}

async function loadCustomCommandsFromDb(): Promise<CustomCommand[]> {
    try {
        const rows = await query<{
            id: string;
            trigger: string;
            aliases: string[] | null;
            response: string;
            enabled: boolean;
            cooldown: number;
            message_type: string;
            color: string;
            description: string;
        }>(
            `SELECT id,
                    trigger,
                    aliases,
                    response,
                    enabled,
                    cooldown,
                    message_type,
                    color,
                    description
             FROM custom_commands`,
        );

        const mapped: CustomCommand[] = rows.map((row) => ({
            id: row.id,
            trigger: row.trigger,
            aliases: row.aliases ?? [],
            response: row.response,
            enabled: row.enabled,
            cooldown: row.cooldown,
            messageType: (row.message_type as CustomCommand['messageType']) ?? 'announcement',
            color: (row.color as CustomCommand['color']) ?? 'primary',
            description: row.description ?? '',
        }));

        console.log(`📋 Загружено ${mapped.length} кастомных команд из БД`);
        return mapped;
    } catch (error) {
        console.error('⚠️ Ошибка загрузки кастомных команд из БД:', error);
        return [];
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
    private readonly CHATTERS_SYNC_INTERVAL_MS = 60 * 1000;
    // Флаг для предотвращения параллельного запуска warmup
    private isWarmingUp: boolean = false;
    
    // Обнаруженные модераторы из сообщений чата (для автоматической установки DUEL_ADMINS)
    private detectedModerators = new Set<string>();

    // Cooldown для команд топа (channel -> Map<commandName, lastUsedTimestamp>)
    private commandCooldowns = new Map<string, Map<string, number>>();
    private readonly COMMAND_COOLDOWN_MS = 5 * 1000; // 5 секунд между использованиями команды в канале
    
    // Отдельный cooldown для каждой announcement команды (из-за лимитов Twitch API)
    private announcementCooldowns = new Map<string, number>(); // key = commandName, value = lastUsedTimestamp
    private readonly ANNOUNCEMENT_COOLDOWN_MS = 10 * 1000; // 10 секунд между повторным использованием одной команды

    // Персональные кулдауны по пользователю (key = channel:command:user)
    private userCommandCooldowns = new Map<string, number>();

    // Конфиг общего текста ссылок для команды !ссылки
    private linksConfig: LinksConfig = { allLinksText: '' };

    // Команды, которые работают всегда (не требуют активного стрима)
    private readonly ALWAYS_AVAILABLE_COMMANDS = new Set([
        '!discord', '!ds', '!дискорд', '!дс',
        '!tg', '!тг',
        '!boosty', '!бусти',
        '!donation', '!донат',
        '!fetta', '!фетта',
        '!fp', '!фп',
        '!ссылки', '!links',
        '!партия', '!party',
        '!персонажи', '!персонаж',
        '!игры', '!help',
        '!смерть', '!смертьинфо', '!смертьоткат', '!смертьсброс',
        '!стоп', '!стопинфо', '!стопоткат', '!стопсброс',
        '!дуэль', '!duel', '!fight',
        '!старт_дуэль', '!start_duel',
        '!стоп_дуэль', '!stop_duel',
        '!амнистия', '!pardon'
    ]);

    // Мапа команд для чистого роутинга
    private readonly commands = this.buildCommandsMap();
    // Кастомные команды из JSON (обновляются динамически)
    private customCommands: Map<string, CustomCommand> = new Map();
    // Кастомные счётчики из БД (обновляются динамически)
    private counters: Map<string, any> = new Map();
    
    private buildCommandsMap(): Map<string, CommandHandler> {
        const map = new Map<string, CommandHandler>();

        const register = (aliases: string[], handler: CommandHandler) => {
            for (const alias of aliases) map.set(alias, handler);
        };

        register(['!dick'], (ch, u, m, msg) => {
            this.dickQueue = this.dickQueue
                .then(() => this.handleDickCommand(ch, u, m, msg))
                .catch(err => console.error('❌ dickQueue error:', err));
        });
        register(['!top_dick', '!topdick'], (ch, u, m, msg) => void this.handleTopDickCommand(ch, u, m, msg));
        register(['!bottom_dick', '!bottomdick'], (ch, u, m, msg) => void this.handleBottomDickCommand(ch, u, m, msg)        );
        register(['!points', '!очки'], (ch, u, m, msg) => void this.handlePointsCommand(ch, u, m, msg));
        register(['!horny', '!хорни'], (ch, u, m, msg) => void this.handleHornyCommand(ch, u));
        register(['!furry', '!фурри', '!фури'], (ch, u, m, msg) => void this.handleFurryCommand(ch, u));
        // Удалены хардкодные команды !fetta, !boosty, !donation, !fp, !discord, !tg
        // Они теперь загружаются из custom-commands.json
        register(['!top_points', '!toppoints', '!топ_очки'], (ch, u, m, msg) => void this.handleTopPointsCommand(ch, u, m, msg));
        register(['!дуэль'], (ch, u, m, msg) => void this.handleDuelCommand(ch, u, m, msg));
        register(['!принять'], (ch, u, m, msg) => void this.handleAcceptDuelCommand(ch, u, msg));
        register(['!отклонить'], (ch, u, m, msg) => void this.handleDeclineDuelCommand(ch, u, msg));
        register(['!стоп_дуэль'], (ch, u, m, msg) => void this.handleDisableDuelsCommand(ch, u, msg));
        register(['!старт_дуэль'], (ch, u, m, msg) => void this.handleEnableDuelsCommand(ch, u, msg));
        register(['!амнистия'], (ch, u, m, msg) => void this.handleDuelPardonCommand(ch, u, msg));
        register(['!крыса'], (ch, u, m, msg) => void this.handleRatCommand(ch, u, m, msg));
        register(['!милашка'], (ch, u, m, msg) => void this.handleCutieCommand(ch, u, m, msg));
        register(['!vanish'], (ch, u, m, msg) => void this.handleVanishCommand(ch, u, msg));
        register(['!стоп'], (ch, u, m, msg) => void this.handleStopCommand(ch, u, msg));
        register(['!стопоткат'], (ch, u, m, msg) => void this.handleStopRollbackCommand(ch, u, msg));
        register(['!стопсброс'], (ch, u, m, msg) => void this.handleStopResetCommand(ch, u, msg));
        register(['!стопинфо'], (ch, u, m, msg) => void this.handleStopInfoCommand(ch, u, msg));
        register(['!смерть'], (ch, u, m, msg) => void this.handleDeathCommand(ch, u, msg));
        register(['!смертьоткат'], (ch, u, m, msg) => void this.handleDeathRollbackCommand(ch, u, msg));
        register(['!смертьсброс'], (ch, u, m, msg) => void this.handleDeathResetCommand(ch, u, msg));
        register(['!смертьинфо'], (ch, u, m, msg) => void this.handleDeathInfoCommand(ch, u, msg));
        register(['!персонажи'], (ch, u, m, msg) => void this.handleCharactersListCommand(ch, u, msg));
        register(['!игры', '!help'], (ch, u, m, msg) => void this.handleGamesCommand(ch, u, msg));
        register(['!ссылки', '!links'], (ch, u, m, msg) => void this.handleLinksCommand(ch, u, msg));
        register(['!команда', '!команды', '!commands'], (ch, u, m, msg) => void this.handleAllCommandsCommand(ch, u, msg));
        register(['!партия', '!party'], (ch, u, m, msg) => void this.handlePartyCommand(ch, u, msg));

        return map;
    }

    private isBroadcaster(user: string): boolean {
        return user.trim().toLowerCase() === this.channelName;
    }

    private async getUserIdCached(username: string): Promise<string | null> {
        const normalizedUsername = username.trim().toLowerCase();

        let userId = this.userIdCache.get(normalizedUsername);
        if (userId) return userId;

        try {
            const userData = await this.helix<{ data: Array<{ id: string }> }>(
                `https://api.twitch.tv/helix/users?login=${encodeURIComponent(normalizedUsername)}`
            );

            if (!userData?.data?.length) return null;

            userId = userData.data[0].id;
            this.userIdCache.set(normalizedUsername, userId);
            return userId;
        } catch (error: any) {
            console.error(`❌ Ошибка получения userId для ${normalizedUsername}:`, error?.message || error);
            return null;
        }
    }

    constructor() {
        // Загружаем состояние счётчиков при создании
        const countersState = loadCountersState();

        for (const [username, count] of Object.entries(countersState.stopCounters)) {
            this.stopCounters.set(username, count);
        }

        for (const [username, count] of Object.entries(countersState.deathCounters)) {
            this.deathCounters.set(username, count);
        }

        // Конфиг ссылок загружается из БД в main через reloadLinksConfigAsync()

        // Загружаем кастомные команды
        this.reloadCustomCommands();
        
        // Загружаем счётчики
        this.reloadCounters();
    }
    
    /**
     * Перезагружает кастомные команды из БД
     */
    public reloadCustomCommands(): void {
        loadCustomCommandsFromDb()
            .then((commands) => {
                this.customCommands.clear();

                for (const cmd of commands) {
                    if (!cmd.enabled) continue;

                    const triggerLower = cmd.trigger.toLowerCase();
                    this.customCommands.set(triggerLower, cmd);

                    for (const alias of cmd.aliases) {
                        const aliasLower = alias.toLowerCase();
                        this.customCommands.set(aliasLower, cmd);
                    }
                }

                const enabledCount = commands.filter((c) => c.enabled).length;
                console.log(`✅ Перезагружено ${enabledCount}/${commands.length} кастомных команд`);
            })
            .catch((error) => {
                console.error('❌ Ошибка перезагрузки кастомных команд:', error);
            });
    }

    /**
     * Перезагружает счётчики из БД
     */
    public reloadCounters(): void {
        query('SELECT id, trigger, aliases, response_template, value, enabled, description FROM counters')
            .then((rows: any[]) => {
                this.counters.clear();

                for (const row of rows) {
                    if (!row.enabled) continue;

                    const counter = {
                        id: row.id,
                        trigger: row.trigger,
                        aliases: row.aliases || [],
                        responseTemplate: row.response_template,
                        value: row.value || 0,
                        description: row.description || '',
                    };

                    const triggerLower = counter.trigger.toLowerCase();
                    this.counters.set(triggerLower, counter);

                    for (const alias of counter.aliases) {
                        const aliasLower = alias.toLowerCase();
                        this.counters.set(aliasLower, counter);
                    }
                }

                const enabledRows = rows.filter((r: any) => r.enabled);
                console.log(`✅ Перезагружено ${enabledRows.length}/${rows.length} счётчиков`);
            })
            .catch((error) => {
                console.error('❌ Ошибка перезагрузки счётчиков:', error);
            });
    }

    /**
     * Выполнить кастомную команду по ID (используется веб-интерфейсом)
     * skipCooldown: при true (из UI) игнорируем кулдаун — админ явно хочет отправить
     */
    public async executeCustomCommandById(id: string): Promise<void> {
        const commands = await loadCustomCommandsFromDb();
        const command = commands.find((c) => c.id === id);

        if (!command) {
            throw new Error(`Команда с id="${id}" не найдена`);
        }

        if (!this.channelName) {
            throw new Error('Чат ещё не подключен — дождитесь подключения к Twitch');
        }

        console.log(`🧷 Ручной запуск кастомной команды из UI: ${command.trigger} (id: ${id})`);
        await this.handleCustomCommand(`#${this.channelName}`, this.channelName, command, null, { skipCooldown: true });
    }

    /**
     * Перезагружает конфиг ссылок из БД (асинхронно)
     */
    public async reloadLinksConfigAsync(): Promise<void> {
        this.linksConfig = await loadLinksConfigFromDb();
        const preview = this.linksConfig.allLinksText
            ? this.linksConfig.allLinksText.substring(0, 80).replace(/\s+/g, ' ')
            : '(пусто)';
        console.log(`✅ Конфиг ссылок перезагружен (БД), длина=${this.linksConfig.allLinksText.length} символов, превью: ${preview}`);
    }

    /** Вызов перезагрузки конфига ссылок (для колбэка без await) */
    public reloadLinksConfig(): void {
        void this.reloadLinksConfigAsync();
    }

    /**
     * Ручной запуск ответа !ссылки из веб-интерфейса (как обычное сообщение, не объявление)
     */
    public async executeLinksFromUi(): Promise<void> {
        try {
            if (!this.channelName) {
                console.log('⚠️ Нельзя выполнить !ссылки из UI — чат ещё не подключен');
                return;
            }

            console.log('🧷 Ручной запуск команды !ссылки из UI');
            await this.handleLinksCommand(`#${this.channelName}`, this.channelName, null);
        } catch (error) {
            console.error('❌ Ошибка при ручном запуске !ссылки из UI:', error);
        }
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

                // Некоторые Helix endpoints (например, announcements) могут возвращать 204 или пустое тело
                const contentLength = res.headers.get('content-length');
                if (res.status === 204 || contentLength === '0') {
                    return undefined as T;
                }

                // Пробуем распарсить JSON; если тело пустое/битое — логируем и бросаем осмысленную ошибку
                try {
                    return (await res.json()) as T;
                } catch (parseError: any) {
                    const text = await res.text().catch(() => '');
                    const error = new Error(
                        `Failed to parse Helix JSON response (status ${res.status}): ${parseError?.message || parseError}. Body: ${text}`
                    );
                    (error as any).status = res.status;
                    throw error;
                }

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
            // Если уже подключены, не подключаемся повторно
            if (this.chatClient) {
                console.log('⚠️ ChatClient уже подключен, пропускаем повторное подключение');
                return true;
            }

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
                
                // Модераторы будут обнаружены автоматически когда напишут сообщение в чат
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

                // Проверяем роли пользователя из тегов сообщения (в реальном времени)
                const isMod = msg.userInfo.isMod;
                const isBroadcaster = msg.userInfo.isBroadcaster;
                const isModNow = isMod || isBroadcaster;
                const wasModBefore = this.detectedModerators.has(username);
                
                // Если пользователь модератор - добавляем в список админов дуэлей
                if (isModNow && !wasModBefore) {
                    console.log(`🛡️ Обнаружен модератор в чате: ${username}`);
                    this.detectedModerators.add(username);
                    setDuelAdminsFromModerators(Array.from(this.detectedModerators));
                }
                // Если пользователь больше НЕ модератор, но был в списке - удаляем (сняли модерку)
                else if (!isModNow && wasModBefore) {
                    console.log(`⚠️ У пользователя ${username} забрали права модератора - удаляем из админов`);
                    this.detectedModerators.delete(username);
                    setDuelAdminsFromModerators(Array.from(this.detectedModerators));
                }

                // Отслеживаем активных пользователей для команды !крыса (fallback)
                addActiveUser(channel, username);

                // Триггерим оверлей на каждое сообщение пользователя
                triggerOverlayPlayer(user).catch((error: any) => {
                    console.error(
                        '⚠️ Ошибка Overlay trigger для сообщения:',
                        error?.message || error
                    );
                });

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

                // Проверяем команду !дуэль с параметрами (например: !дуэль @user или !дуэль user)
                if (trimmedMessage.startsWith('!дуэль ')) {
                    // Проверка что стрим онлайн
                    if (!this.isStreamOnlineCheck() && !IS_LOCAL) {
                        console.log(`⚠️ Команда !дуэль проигнорирована: стрим оффлайн`);
                        return;
                    }

                    if (IS_LOCAL && !this.isStreamOnlineCheck()) {
                        console.log(`🧪 ТЕСТ в оффлайне: выполняем команду !дуэль`);
                    }

                    this.handleDuelCommand(channel, user, message, msg);
                    return;
                }

                // Команда выбора персонажа: !персонаж <имя>
                if (trimmedMessage.startsWith('!персонаж ')) {
                    this.handleSetCharacterCommand(channel, user, message, msg);
                    return;
                }

                // Проверяем, есть ли команда в мапе
                const commandHandler = this.commands.get(trimmedMessage);
                if (commandHandler) {
                    console.log(`🎯 Обработка команды: ${trimmedMessage}`);
                    
                    // Промо-команды и информационные команды работают всегда
                    const isAlwaysAvailable = this.ALWAYS_AVAILABLE_COMMANDS.has(trimmedMessage);

                    // Игровые команды работают только когда стрим онлайн (или локально для теста)
                    if (!isAlwaysAvailable && !this.isStreamOnlineCheck() && !IS_LOCAL) {
                        console.log(`⚠️ Команда ${trimmedMessage} проигнорирована: стрим оффлайн (игровая команда)`);
                        return;
                    }

                    // Локально показываем что тестируем в оффлайне
                    if (IS_LOCAL && !this.isStreamOnlineCheck()) {
                        console.log(`🧪 ТЕСТ в оффлайне: выполняем команду ${trimmedMessage}`);
                    }

                    commandHandler(channel, user, message, msg);
                    return;
                }
                
                // Проверяем кастомные команды из JSON
                const customCommand = this.customCommands.get(trimmedMessage);
                if (customCommand) {
                    console.log(`🎨 Обработка кастомной команды: ${trimmedMessage} (id: ${customCommand.id})`);
                    this.handleCustomCommand(channel, user, customCommand, msg);
                    return;
                }

                // Проверяем счётчики из БД (точное совпадение — инкремент)
                const counter = this.counters.get(trimmedMessage);
                if (counter) {
                    console.log(`🔢 Обработка счётчика: ${trimmedMessage} (id: ${counter.id})`);
                    this.handleCounterCommand(channel, user, counter, msg);
                    return;
                }

                // Кастомные счётчики: !{trigger}инфо, !{trigger}сброс, !{trigger}откат, !{trigger}[число]
                const variantMatch = trimmedMessage.match(/^(![a-zа-яё0-9_]+)(инфо|сброс|откат|\d+)$/);
                if (variantMatch) {
                    const base = variantMatch[1];
                    const suffix = variantMatch[2];
                    const baseCounter = this.counters.get(base);
                    if (baseCounter && baseCounter.id !== 'stop' && baseCounter.id !== 'death') {
                        if (suffix === 'инфо') {
                            this.handleCounterInfoCommand(channel, user, baseCounter, msg);
                        } else if (suffix === 'сброс') {
                            this.handleCounterResetCommand(channel, user, baseCounter, msg);
                        } else if (suffix === 'откат') {
                            this.handleCounterRollbackCommand(channel, user, baseCounter, msg);
                        } else {
                            const targetValue = parseInt(suffix, 10);
                            if (targetValue >= 0 && targetValue <= 9999) {
                                this.handleCounterSetCommand(channel, user, baseCounter, targetValue, msg);
                            }
                        }
                        return;
                    }
                }
            });

            // Отслеживаем ритуалы (первое сообщение нового зрителя)
            this.chatClient.onRitual((channel, user, ritualInfo, msg) => {
                console.log(`🎉 Ritual событие: ${ritualInfo.ritualName} от ${user}`);

                if (ritualInfo.ritualName === 'new_chatter') {
                    console.log(`👋 Новый зритель: ${user} - ${ritualInfo.message || ''}`);
                }
            });

            // Отслеживаем серии просмотров (watch streaks) и другие события через низкоуровневый IRC
            // @twurple пока не имеет специального обработчика для viewermilestone
            this.chatClient.irc.onAnyMessage((ircMessage) => {
                const raw = ircMessage as any;
                
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
     * Проверка cooldown для команды в канале
     * @returns true если cooldown активен, false если можно использовать команду
     */
    private isCommandOnCooldown(channel: string, commandName: string): boolean {
        const now = Date.now();
        let channelCooldowns = this.commandCooldowns.get(channel);

        if (!channelCooldowns) {
            channelCooldowns = new Map();
            this.commandCooldowns.set(channel, channelCooldowns);
        }

        const lastUsed = channelCooldowns.get(commandName);
        if (lastUsed && now - lastUsed < this.COMMAND_COOLDOWN_MS) {
            const secondsLeft = Math.ceil((this.COMMAND_COOLDOWN_MS - (now - lastUsed)) / 1000);
            console.log(`⏳ Команда ${commandName} на cooldown, осталось ${secondsLeft} сек`);
            return true;
        }

        // Обновляем время последнего использования
        channelCooldowns.set(commandName, now);
        return false;
    }

    /**
     * Проверка cooldown для announcement команд (защита от rate limit Twitch API)
     * @returns true если cooldown активен, false если можно отправить announcement
     */
    /**
     * Проверка кулдауна для конкретной announcement команды (БЕЗ установки нового)
     * @param commandName - название команды (например: '!дс', '!тг')
     * @param cooldownMsOverride - кастомный кулдаун в миллисекундах (если не задан, берётся дефолтный ANNOUNCEMENT_COOLDOWN_MS)
     * @returns true если команда на кулдауне, false если можно использовать
     */
    private isAnnouncementOnCooldown(commandName: string, cooldownMsOverride?: number): boolean {
        const now = Date.now();
        const lastUsed = this.announcementCooldowns.get(commandName);
        const cooldownMs = cooldownMsOverride ?? this.ANNOUNCEMENT_COOLDOWN_MS;
        
        if (lastUsed && now - lastUsed < cooldownMs) {
            const secondsLeft = Math.ceil((cooldownMs - (now - lastUsed)) / 1000);
            console.log(`⏳ Команда ${commandName} на cooldown, осталось ${secondsLeft} сек`);
            return true;
        }

        return false;
    }

    /**
     * Установить кулдаун для команды (вызывается ПОСЛЕ успешной отправки)
     * @param commandName - название команды
     */
    private setAnnouncementCooldown(commandName: string): void {
        this.announcementCooldowns.set(commandName, Date.now());
    }

    /**
     * Обработка команды !dick из чата
     */
    private async handleDickCommand(channel: string, user: string, message: string, msg: any) {
        console.log(`🎮 Команда !dick от ${user} в ${channel}`);

        try {
            const response = await processTwitchDickCommand(user);
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

        // Проверка cooldown
        if (this.isCommandOnCooldown(channel, 'top_dick')) {
            return; // Игнорируем команду, если она на cooldown
        }

        try {
            const response = await processTwitchTopDickCommand();
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

        // Проверка cooldown
        if (this.isCommandOnCooldown(channel, 'bottom_dick')) {
            return; // Игнорируем команду, если она на cooldown
        }

        try {
            const response = await processTwitchBottomDickCommand();
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
            const response = await processTwitchPointsCommand(user);
            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !points:', error);
        }
    }

    private async handleHornyCommand(channel: string, user: string) {
        try {
            // Стример без личного КД, для остальных — 1 раз в минуту
            if (!this.isBroadcaster(user)) {
                const key = `${channel}:horny:${user.toLowerCase()}`;
                const lastUsed = this.userCommandCooldowns.get(key);
                const now = Date.now();
                const COOLDOWN_MS = 60 * 1000;

                if (lastUsed && now - lastUsed < COOLDOWN_MS) {
                    return;
                }

                this.userCommandCooldowns.set(key, now);
            }

            const userId = await this.getUserIdCached(user);

            const min = -69;
            const max = 666;

            let value: number;
            if (userId === '897528838') {
                // Для стримера: 90% случаев 666, 10% случаев 665
                const roll = Math.random();
                value = roll < 0.1 ? 665 : 666;
            } else {
                value = Math.floor(Math.random() * (max - min + 1)) + min;
            }

            await this.sendMessage(channel, `${user} хорни на ${value}%`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !horny:', error);
        }
    }

    private async handleFurryCommand(channel: string, user: string) {
        try {
            // Стример без личного КД, для остальных — 1 раз в минуту
            if (!this.isBroadcaster(user)) {
                const key = `${channel}:furry:${user.toLowerCase()}`;
                const lastUsed = this.userCommandCooldowns.get(key);
                const now = Date.now();
                const COOLDOWN_MS = 60 * 1000;

                if (lastUsed && now - lastUsed < COOLDOWN_MS) {
                    return;
                }

                this.userCommandCooldowns.set(key, now);
            }

            const userId = await this.getUserIdCached(user);

            const min = 1;
            const max = 100;

            let value: number;
            if (userId === '897528838') {
                // Для стримера: 90% случаев -100, 10% случаев +100
                const roll = Math.random();
                value = roll < 0.1 ? 100 : -100;
            } else {
                value = Math.floor(Math.random() * (max - min + 1)) + min;
            }

            await this.sendMessage(channel, `${user} ты на ${value}% фурри`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !furry:', error);
        }
    }

    /**
     * Обработка кастомной команды (из БД)
     * - Для обычных сообщений (message):
     *   cooldown=0 → без ограничений, >0 → используем указанный кулдаун в секундах.
     * - Для объявлений (announcement):
     *   минимум 5 секунд даже если cooldown=0, при большем значении берём его.
     * - options.skipCooldown: true — при вызове из веб-UI игнорируем кулдаун
     */
    /**
     * Подставляет плейсхолдеры времени в текст.
     * Формат: {time:IANA_TIMEZONE} — например {time:Europe/Moscow}, {time:America/New_York}.
     */
    private substituteTimePlaceholders(text: string): string {
        const now = new Date();
        const fmt = (tz: string) => {
            try {
                return new Intl.DateTimeFormat('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                    timeZone: tz,
                }).format(now);
            } catch {
                return `?(${tz})`;
            }
        };
        return text.replace(/\{time:([^}]+)\}/g, (_, tz) => fmt(tz.trim()));
    }

    private async handleCustomCommand(channel: string, user: string, command: CustomCommand, msg: any, options?: { skipCooldown?: boolean }) {
        try {
            const cooldownKey = command.id;
            const rawCooldownSec = command.cooldown ?? 0;
            const skipCooldown = options?.skipCooldown ?? false;
            const response = this.substituteTimePlaceholders(command.response);

            if (command.messageType === 'announcement') {
                // Минимум 5 секунд для объявлений (если не skipCooldown)
                const effectiveCooldownSec = Math.max(5, rawCooldownSec);
                const cooldownMs = effectiveCooldownSec * 1000;

                if (!skipCooldown && this.isAnnouncementOnCooldown(cooldownKey, cooldownMs)) {
                    return;
                }

                const success = await this.sendAnnouncement(response, command.color);

                if (!success) {
                    throw new Error('Не удалось отправить объявление (проверьте broadcasterId/moderatorId или Helix API)');
                }

                if (!skipCooldown) {
                    this.setAnnouncementCooldown(cooldownKey);
                }
                console.log(
                    `✅ Кастомное объявление "${command.trigger}" отправлено` +
                        (skipCooldown ? ' (из UI)' : ` (cooldown=${effectiveCooldownSec} сек)`),
                );
            } else {
                // Обычное сообщение
                const shouldCheckCooldown = rawCooldownSec > 0 && !skipCooldown;
                const cooldownMs = rawCooldownSec * 1000;

                if (shouldCheckCooldown && this.isAnnouncementOnCooldown(cooldownKey, cooldownMs)) {
                    return;
                }

                await this.sendMessage(channel, response);

                if (shouldCheckCooldown) {
                    this.setAnnouncementCooldown(cooldownKey);
                }

                console.log(
                    `✅ Кастомное сообщение "${command.trigger}" отправлено` +
                        (skipCooldown ? ' (из UI)' : (shouldCheckCooldown ? ` (cooldown=${rawCooldownSec} сек)` : ' (без кулдауна)')),
                );
            }
        } catch (error) {
            console.error(`❌ Ошибка при обработке кастомной команды ${command.trigger}:`, error);
            // При вызове из UI (skipCooldown) пробрасываем ошибку, чтобы API вернул 500
            if (options?.skipCooldown) {
                throw error;
            }
        }
    }

    /**
     * Обработка счётчика (из БД)
     * - Инкрементирует значение в БД
     * - Отправляет ответ с подставленным значением
     */
    private async handleCounterCommand(channel: string, user: string, counter: any, msg: any) {
        try {
            // Инкрементируем счётчик в БД
            await query('UPDATE counters SET value = value + 1 WHERE id = $1', [counter.id]);
            
            // Получаем новое значение
            const result = await query('SELECT value FROM counters WHERE id = $1', [counter.id]);
            const newValue = result[0]?.value || (counter.value + 1);

            // Подставляем значение в шаблон
            const response = counter.responseTemplate.replace(/{value}/g, newValue.toString());

            // Отправляем в чат
            await this.sendMessage(channel, response);

            console.log(`✅ Счётчик "${counter.trigger}" = ${newValue}`);

            // Перезагружаем счётчики чтобы обновить кеш
            this.reloadCounters();
        } catch (error) {
            console.error(`❌ Ошибка при обработке счётчика ${counter.trigger}:`, error);
        }
    }

    /** !{trigger}инфо — показать текущее значение кастомного счётчика */
    private async handleCounterInfoCommand(channel: string, user: string, counter: any, msg: any) {
        try {
            const result = await query('SELECT value, response_template FROM counters WHERE id = $1', [counter.id]);
            const currentValue = result[0]?.value ?? 0;
            const template = result[0]?.response_template ?? '{value}';
            const response = currentValue === 0
                ? `Счётчик ${counter.trigger} пока на нуле`
                : template.replace(/{value}/g, currentValue.toString());
            await this.sendMessage(channel, response);
        } catch (error) {
            console.error(`❌ handleCounterInfo ${counter.trigger}:`, error);
        }
    }

    /** !{trigger}сброс — сбросить кастомный счётчик в 0 */
    private async handleCounterResetCommand(channel: string, user: string, counter: any, msg: any) {
        try {
            await query('UPDATE counters SET value = 0 WHERE id = $1', [counter.id]);
            await this.sendMessage(channel, `Счётчик ${counter.trigger} сброшен`);
            this.reloadCounters();
        } catch (error) {
            console.error(`❌ handleCounterReset ${counter.trigger}:`, error);
        }
    }

    /** !{trigger}откат — откатить на 1 (уменьшить значение) */
    private async handleCounterRollbackCommand(channel: string, user: string, counter: any, msg: any) {
        try {
            const result = await query('SELECT value FROM counters WHERE id = $1', [counter.id]);
            const currentValue = result[0]?.value ?? 0;
            if (currentValue <= 0) {
                await this.sendMessage(channel, `Нет значений для отката`);
                return;
            }
            const newValue = currentValue - 1;
            await query('UPDATE counters SET value = $1 WHERE id = $2', [newValue, counter.id]);
            const template = (await query('SELECT response_template FROM counters WHERE id = $1', [counter.id]))[0]?.response_template ?? '{value}';
            const response = newValue === 0
                ? `Откат выполнен, счётчик сброшен`
                : template.replace(/{value}/g, newValue.toString());
            await this.sendMessage(channel, response);
            this.reloadCounters();
        } catch (error) {
            console.error(`❌ handleCounterRollback ${counter.trigger}:`, error);
        }
    }

    /** !{trigger}[число] — установить значение кастомного счётчика */
    private async handleCounterSetCommand(channel: string, user: string, counter: any, targetValue: number, msg: any) {
        try {
            await query('UPDATE counters SET value = $1 WHERE id = $2', [targetValue, counter.id]);
            const result = await query('SELECT response_template FROM counters WHERE id = $1', [counter.id]);
            const template = result[0]?.response_template ?? '{value}';
            const response = `Счётчик установлен: ${template.replace(/{value}/g, targetValue.toString())}`;
            await this.sendMessage(channel, response);
            this.reloadCounters();
        } catch (error) {
            console.error(`❌ handleCounterSet ${counter.trigger}:`, error);
        }
    }

    private async handleDiscordCommand(channel: string, user: string, message: string, msg: any) {
        try {
            // Проверка announcement cooldown
            if (this.isAnnouncementOnCooldown('!дс')) {
                return; // Игнорируем команду если cooldown активен
            }
            
            const text = 'Тут я мурчу в свободное время discord.com/invite/zrNsn4vAw2';
            const success = await this.sendAnnouncement(text, this.getRandomAnnouncementColor());
            
            if (success) {
                this.setAnnouncementCooldown('!дс');
                console.log('✅ Объявление с Discord-ссылкой отправлено');
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !discord:', error);
        }
    }

    private async handleFettaCommand(channel: string, user: string, message: string, msg: any) {
        try {
            // Проверка announcement cooldown
            if (this.isAnnouncementOnCooldown('!фетта')) {
                return;
            }
            
            const text = 'Тут можно подарить стримеру Ferrari https://fetta.app/u/kunilika666';
            const success = await this.sendAnnouncement(text, this.getRandomAnnouncementColor());
            
            if (success) {
                this.setAnnouncementCooldown('!фетта');
                console.log('✅ Объявление с Fetta-ссылкой отправлено');
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !fetta:', error);
        }
    }

    private async handleBoostyCommand(channel: string, user: string, message: string, msg: any) {
        try {
            // Проверка announcement cooldown
            if (this.isAnnouncementOnCooldown('!бусти')) {
                return;
            }
            
            const text = 'Запретные фото стримера https://boosty.to/kunilika911';
            const success = await this.sendAnnouncement(text, this.getRandomAnnouncementColor());
            
            if (success) {
                this.setAnnouncementCooldown('!бусти');
                console.log('✅ Объявление с Boosty-ссылкой отправлено');
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !boosty:', error);
        }
    }

    private async handleDonationCommand(channel: string, user: string, message: string, msg: any) {
        try {
            // Проверка announcement cooldown
            if (this.isAnnouncementOnCooldown('!донат')) {
                return;
            }
            
            const text = 'Увеличь свой шанс что я приду к тебе ночью https://donatex.gg/donate/kunilika666';
            const success = await this.sendAnnouncement(text, this.getRandomAnnouncementColor());
            
            if (success) {
                this.setAnnouncementCooldown('!донат');
                console.log('✅ Объявление с Donation-ссылкой отправлено');
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !donation:', error);
        }
    }

    private async handleFpCommand(channel: string, user: string, message: string, msg: any) {
        try {
            // Проверка announcement cooldown
            if (this.isAnnouncementOnCooldown('!фп')) {
                return;
            }

            const text = '"Fairy Pixel" - VTube моделька, волшебные нейро-арты, стикеры https://t.me/FairyPixel';
            const success = await this.sendAnnouncement(text, this.getRandomAnnouncementColor());
            
            if (success) {
                this.setAnnouncementCooldown('!фп');
                console.log('✅ Объявление с Fairy Pixel-ссылкой отправлено');
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !fp:', error);
        }
    }

    private async handleTgCommand(channel: string, user: string, message: string, msg: any) {
        try {
            console.log(`📣 handleTgCommand от ${user} в ${channel}`);

            // Проверка announcement cooldown
            if (this.isAnnouncementOnCooldown('!тг')) {
                return;
            }

            const text = 'Тайная жизнь суккуба http://t.me/+rSBrR1FyQqBhZmU1';
            const success = await this.sendAnnouncement(text, this.getRandomAnnouncementColor());

            if (success) {
                this.setAnnouncementCooldown('!тг');
                console.log('✅ Объявление !тг отправлено');
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !tg:', error);
        }
    }

    /**
     * Обработка команды !top_points из чата
     */
    private async handleTopPointsCommand(channel: string, user: string, message: string, msg: any) {
        console.log(`💰 Команда !top_points от ${user} в ${channel}`);

        // Проверка cooldown
        if (this.isCommandOnCooldown(channel, 'top_points')) {
            return; // Игнорируем команду, если она на cooldown
        }

        try {
            const response = await processTwitchTopPointsCommand();
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
        try {
            console.log(`🎯 handleDuelCommand вызван:`);
            console.log(`   channel (raw): "${channel}"`);
            console.log(`   user (raw): "${user}"`);
            console.log(`   message (raw): "${message}"`);
            
            // Парсим сообщение для извлечения целевого пользователя
            const parts = message.trim().split(/\s+/);
            let targetUsername = parts.length > 1 ? parts[1].replace(/^@+/, '') : undefined;
            
            // Фильтруем пустые имена и невидимые символы
            if (targetUsername) {
                // Удаляем все невидимые Unicode символы (Zero-width, combining marks, etc.)
                targetUsername = targetUsername.replace(/[\u200B-\u200D\uFEFF\u034F\u061C\u180E]/g, '').trim();
                // Если после очистки осталась пустая строка, считаем что цель не указана
                if (!targetUsername || targetUsername.length === 0) {
                    targetUsername = undefined;
                }
            }

            if (targetUsername) {
                console.log(`⚔️ Команда !дуэль от ${user} -> вызов @${targetUsername} в ${channel}`);
            } else {
                console.log(`⚔️ Команда !дуэль от ${user} в ${channel} (встать в очередь)`);
            }
            
            log('COMMAND', { command: '!дуэль', username: user, channel, message, targetUsername });

            const result = await processTwitchDuelCommand(user, channel, targetUsername);

            // Если дуэли выключены, response будет пустым - ничего не отправляем
            if (result.response) {
                await this.sendMessage(channel, result.response);
                console.log(`✅ Отправлен ответ в чат: ${result.response}`);
            }
            const duelBonusMessages = (result as { extraMessages?: string[] }).extraMessages;
            if (duelBonusMessages?.length) {
                for (const msg of duelBonusMessages) {
                    await this.sendMessage(channel, msg);
                    console.log(`✅ Отправлено в чат: ${msg}`);
                }
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

            // Если оба проиграли - даём таймаут обоим (длительность из конфига дуэлей)
            const duelTimeoutSec = getDuelTimeoutSeconds();
            if (result.bothLost && result.loser && result.loser2) {
                await this.timeoutUser(result.loser, duelTimeoutSec, 'Duel - Both Lost');
                await this.timeoutUser(result.loser2, duelTimeoutSec, 'Duel - Both Lost');
            } else if (result.loser) {
                await this.timeoutUser(result.loser, duelTimeoutSec, 'Duel');
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !дуэль:', error);
        }
    }

    /**
     * Обработка команды !принять из чата
     */
    private async handleAcceptDuelCommand(channel: string, user: string, msg: any) {
        console.log(`✅ Команда !принять от ${user} в ${channel}`);
        log('COMMAND', { command: '!принять', username: user, channel });

        try {
            const result = await acceptDuelChallenge(user, channel);

            if (result.response) {
                await this.sendMessage(channel, result.response);
                console.log(`✅ Отправлен ответ в чат: ${result.response}`);
            }
            const bonusMessages = (result as { extraMessages?: string[] }).extraMessages;
            if (bonusMessages?.length) {
                for (const msg of bonusMessages) {
                    await this.sendMessage(channel, msg);
                    console.log(`✅ Отправлено в чат: ${msg}`);
                }
            }

            // Логируем результат дуэли если она состоялась
            if (result.loser || result.bothLost) {
                const winner = result.bothLost ? undefined : (result.loser ? (result.loser === user ? result.loser2 || 'unknown' : user) : undefined);
                log('DUEL_RESULT', {
                    player1: result.loser || user,
                    player2: result.loser2 || user,
                    winner,
                    bothLost: result.bothLost,
                    outcome: result.bothLost ? 'both_lost' : winner ? `winner: ${winner}` : 'both_missed',
                    type: 'personal_challenge'
                });
            }

            // Если оба проиграли - даём таймаут обоим (длительность из конфига дуэлей)
            const duelTimeoutSec = getDuelTimeoutSeconds();
            if (result.bothLost && result.loser && result.loser2) {
                await this.timeoutUser(result.loser, duelTimeoutSec, 'Duel - Both Lost');
                await this.timeoutUser(result.loser2, duelTimeoutSec, 'Duel - Both Lost');
            } else if (result.loser) {
                await this.timeoutUser(result.loser, duelTimeoutSec, 'Duel');
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !принять:', error);
        }
    }

    /**
     * Обработка команды !отклонить из чата
     */
    private async handleDeclineDuelCommand(channel: string, user: string, msg: any) {
        console.log(`🏳️ Команда !отклонить от ${user} в ${channel}`);
        log('COMMAND', { command: '!отклонить', username: user, channel });

        try {
            const result = await declineDuelChallenge(user, channel);

            if (result.response) {
                await this.sendMessage(channel, result.response);
                console.log(`✅ Отправлен ответ в чат: ${result.response}`);
            }
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !отклонить:', error);
        }
    }

    /**
     * Обработка команды !стоп_дуэль из чата
     * Отключает дуэли (только для админов)
     */
    private async handleDisableDuelsCommand(channel: string, user: string, msg: any) {
        console.log(`Команда !стоп_дуэль от ${user} в ${channel}`);
        log('COMMAND', { command: '!стоп_дуэль', username: user, channel });

        try {
            const success = disableDuels(user);
            if (success) {
                const response = 'Дуэли остановлены';
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
            }
            // Если нет прав - молча игнорируем
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !стоп_дуэль:', error);
        }
    }

    /**
     * Обработка команды !старт_дуэль из чата
     * Включает дуэли (только для админов)
     */
    private async handleEnableDuelsCommand(channel: string, user: string, msg: any) {
        console.log(`✅ Команда !старт_дуэль от ${user} в ${channel}`);
        log('COMMAND', { command: '!старт_дуэль', username: user, channel });

        try {
            const success = enableDuels(user);
            if (success) {
                const response = 'Дуэли возобновлены';
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
            }
            // Если нет прав - молча игнорируем
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
            const result = await pardonAllDuelTimeouts(user);

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
                    // Пытаемся снять таймаут в Twitch
                    const success = await this.untimeoutUser(username);
                    if (success) {
                        unbannedCount++;
                    }

                    // В любом случае шлём событие амнистии в оверлей для этого ника
                    amnestyOverlayPlayer(username).catch(error => {
                        console.error(
                            '⚠️ Ошибка вызова Overlay amnesty для игрока:',
                            username,
                            (error as any)?.message || error
                        );
                    });
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
     * Обработка команды !jump из чата
     * Тригерит анимацию прыжка персонажа в оверлее
     */
    private async handleJumpCommand(channel: string, user: string, msg: any) {
        console.log(`🕴 Команда !jump от ${user} в ${channel}`);

        try {
            await jumpOverlayPlayer(user);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !jump:', error);
        }
    }

    /**
     * Обработка команды !стоп из чата
     * Увеличивает счётчик остановок стрима для kunilika666 (независимо от того, кто написал команду)
     */
    private async handleStopCommand(channel: string, user: string, msg: any) {
        console.log(`🛑 Команда !стоп от ${user} в ${channel}`);

        try {
            // Проверяем что счётчик включен
            const check = await query('SELECT enabled FROM counters WHERE id = $1', ['stop']);
            if (!check[0]?.enabled) {
                console.log('⚠️ Счётчик !стоп выключен, команда проигнорирована');
                return;
            }

            // Инкрементируем счётчик в БД
            await query('UPDATE counters SET value = value + 1 WHERE id = $1', ['stop']);
            
            // Получаем новое значение и шаблон
            const result = await query('SELECT value, response_template FROM counters WHERE id = $1', ['stop']);
            const newCount = result[0]?.value || 1;
            const template = result[0]?.response_template || 'Количество стопов: {value}';

            // Используем шаблон из БД
            const response = template.replace(/{value}/g, newCount.toString());

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
            
            // Обновляем кеш
            this.reloadCounters();
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
            // Проверяем что счётчик включен
            const check = await query('SELECT enabled FROM counters WHERE id = $1', ['stop']);
            if (!check[0]?.enabled) {
                console.log('⚠️ Счётчик !стоп выключен, команда проигнорирована');
                return;
            }

            if (targetValue < 0 || targetValue > 9999) {
                const response = `Значение должно быть от 0 до 9999`;
                await this.sendMessage(channel, response);
                console.log(`⚠️ Некорректное значение: ${targetValue}`);
                return;
            }

            // Обновляем значение в БД
            await query('UPDATE counters SET value = $1 WHERE id = $2', [targetValue, 'stop']);
            
            // Получаем шаблон
            const result = await query('SELECT response_template FROM counters WHERE id = $1', ['stop']);
            const template = result[0]?.response_template || 'Количество стопов: {value}';

            // Используем шаблон из БД
            const response = `Счётчик установлен: ${template.replace(/{value}/g, targetValue.toString())}`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
            
            // Обновляем кеш
            this.reloadCounters();
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
            // Получаем текущее значение из БД
            const result = await query('SELECT value, enabled FROM counters WHERE id = $1', ['stop']);
            if (!result[0]?.enabled) {
                console.log('⚠️ Счётчик !стоп выключен, команда проигнорирована');
                return;
            }
            const currentCount = result[0]?.value || 0;

            if (currentCount === 0) {
                const response = `Нет остановок для отката`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            const newCount = currentCount - 1;

            // Обновляем в БД
            await query('UPDATE counters SET value = $1 WHERE id = $2', [newCount, 'stop']);

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
            
            // Обновляем кеш
            this.reloadCounters();
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
            // Получаем текущее значение из БД
            const result = await query('SELECT value, enabled FROM counters WHERE id = $1', ['stop']);
            if (!result[0]?.enabled) {
                console.log('⚠️ Счётчик !стоп выключен, команда проигнорирована');
                return;
            }
            const currentCount = result[0]?.value || 0;

            if (currentCount === 0) {
                const response = `Счётчик остановок уже на нуле`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            // Сбрасываем в БД
            await query('UPDATE counters SET value = 0 WHERE id = $1', ['stop']);

            const response = `Счётчик остановок сброшен`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
            
            // Обновляем кеш
            this.reloadCounters();
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
            // Получаем данные счётчика из БД
            const result = await query('SELECT value, response_template, enabled FROM counters WHERE id = $1', ['stop']);
            if (!result[0]?.enabled) {
                console.log('⚠️ Счётчик !стоп выключен, команда проигнорирована');
                return;
            }
            const currentCount = result[0]?.value || 0;
            const template = result[0]?.response_template || 'Количество стопов: {value}';

            if (currentCount === 0) {
                const response = `Счётчик стопов пока на нуле`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            // Используем шаблон из БД
            const response = template.replace(/{value}/g, currentCount.toString());

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
            // Проверяем что счётчик включен
            const check = await query('SELECT enabled FROM counters WHERE id = $1', ['death']);
            if (!check[0]?.enabled) {
                console.log('⚠️ Счётчик !смерть выключен, команда проигнорирована');
                return;
            }

            // Инкрементируем счётчик в БД
            await query('UPDATE counters SET value = value + 1 WHERE id = $1', ['death']);
            
            // Получаем новое значение и шаблон
            const result = await query('SELECT value, response_template FROM counters WHERE id = $1', ['death']);
            const newCount = result[0]?.value || 1;
            const template = result[0]?.response_template || 'Смертей: {value}';

            // Используем шаблон из БД
            const response = template.replace(/{value}/g, newCount.toString());

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
            
            // Обновляем кеш
            this.reloadCounters();
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
            // Проверяем что счётчик включен
            const check = await query('SELECT enabled FROM counters WHERE id = $1', ['death']);
            if (!check[0]?.enabled) {
                console.log('⚠️ Счётчик !смерть выключен, команда проигнорирована');
                return;
            }

            if (targetValue < 0 || targetValue > 9999) {
                const response = `Значение должно быть от 0 до 9999`;
                await this.sendMessage(channel, response);
                console.log(`⚠️ Некорректное значение: ${targetValue}`);
                return;
            }

            // Обновляем значение в БД
            await query('UPDATE counters SET value = $1 WHERE id = $2', [targetValue, 'death']);
            
            // Получаем шаблон
            const result = await query('SELECT response_template FROM counters WHERE id = $1', ['death']);
            const template = result[0]?.response_template || 'Смертей: {value}';

            // Используем шаблон из БД
            const response = `Счётчик установлен: ${template.replace(/{value}/g, targetValue.toString())}`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
            
            // Обновляем кеш
            this.reloadCounters();
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
            // Получаем текущее значение из БД
            const result = await query('SELECT value, enabled FROM counters WHERE id = $1', ['death']);
            if (!result[0]?.enabled) {
                console.log('⚠️ Счётчик !смерть выключен, команда проигнорирована');
                return;
            }
            const currentCount = result[0]?.value || 0;

            if (currentCount === 0) {
                const response = `Нет смертей для отката`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            const newCount = currentCount - 1;

            // Обновляем в БД
            await query('UPDATE counters SET value = $1 WHERE id = $2', [newCount, 'death']);

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
            
            // Обновляем кеш
            this.reloadCounters();
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
            // Получаем текущее значение из БД
            const result = await query('SELECT value, enabled FROM counters WHERE id = $1', ['death']);
            if (!result[0]?.enabled) {
                console.log('⚠️ Счётчик !смерть выключен, команда проигнорирована');
                return;
            }
            const currentCount = result[0]?.value || 0;

            if (currentCount === 0) {
                const response = `Счётчик смертей уже на нуле`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            // Сбрасываем в БД
            await query('UPDATE counters SET value = 0 WHERE id = $1', ['death']);

            const response = `Счётчик смертей сброшен`;

            await this.sendMessage(channel, response);
            console.log(`✅ Отправлен ответ в чат: ${response}`);
            
            // Обновляем кеш
            this.reloadCounters();
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
            // Получаем данные счётчика из БД
            const result = await query('SELECT value, response_template, enabled FROM counters WHERE id = $1', ['death']);
            if (!result[0]?.enabled) {
                console.log('⚠️ Счётчик !смерть выключен, команда проигнорирована');
                return;
            }
            const currentCount = result[0]?.value || 0;
            const template = result[0]?.response_template || 'Смертей: {value}';

            if (currentCount === 0) {
                const response = `Счётчик смертей пока на нуле`;
                await this.sendMessage(channel, response);
                console.log(`✅ Отправлен ответ в чат: ${response}`);
                return;
            }

            // Используем шаблон из БД
            const response = template.replace(/{value}/g, currentCount.toString());

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
            '!команды (!команда, !commands) — список включённых команд из таблицы',
            '!dick - вырастить письку',
            '!top_dick - топ длинных',
            '!bottom_dick - топ коротких',
            '!очки - свои очки',
            '!топ_очки - топ очки',
            '!хорни/!horny',
            '!фурри/!фури/!furry',
            '!ссылки - список всех ссылок',
            '!дуэль - встать в очередь на дуэль',
            '!дуэль @user - вызвать конкретного игрока на дуэль',
            '!крыса/!милашка - выбрать случайную крысу/милашку из чата',
            '!vanish - скрыть свои сообщения',
            '!персонажи - показать персонажей',
            '!персонаж <имя> - выбрать персонажа',
            '!jump/!j - прыжок'
        ];

        const response = `📋Список доступных команд в чате:\n${commandsList.join(' • ')}`;

        try {
            await this.sendMessage(channel, response);
            console.log(`✅ Список команд отправлен в чат`);
        } catch (error) {
            console.error('❌ Ошибка при отправке списка команд:', error);
        }
    }

    /**
     * Обработка команды !партия / !party
     * Случайный элемент из списка, раз в сутки на пользователя
     */
    private async handlePartyCommand(channel: string, user: string, msg: any) {
        console.log(`🎉 Команда !партия от ${user} в ${channel}`);

        const COOLDOWN_HOURS = 24;

        try {
            const items = await query<{ id: number; text: string }>(
                'SELECT id, text FROM party_items ORDER BY sort_order, id',
            );

            if (items.length === 0) {
                await this.sendMessage(channel, 'Список партии пуст, добавьте элементы в админке.');
                return;
            }

            const skipCooldownRow = await queryOne<{ skip_cooldown: boolean }>(
                'SELECT skip_cooldown FROM party_config WHERE id = 1',
            );
            const skipCooldown = skipCooldownRow?.skip_cooldown ?? false;

            const userNorm = user.trim().toLowerCase();
            const cooldownRow = !skipCooldown
                ? await queryOne<{ last_used_at: Date }>(
                      'SELECT last_used_at FROM party_cooldown WHERE twitch_username = $1',
                      [userNorm],
                  )
                : null;

            if (!skipCooldown && cooldownRow) {
                const lastUsed = new Date(cooldownRow.last_used_at).getTime();
                const hoursSince = (Date.now() - lastUsed) / (1000 * 60 * 60);
                if (hoursSince < COOLDOWN_HOURS) {
                    await this.sendMessage(
                        channel,
                        `@${user}, можно использовать партию раз в сутки.`,
                    );
                    return;
                }
            }

            const config = await queryOne<{ elements_count: number; quantity_max: number }>(
                'SELECT elements_count, quantity_max FROM party_config WHERE id = 1',
            );
            const elementsCount = Math.min(items.length, config?.elements_count ?? 2);
            const quantityMax = Math.max(1, config?.quantity_max ?? 4);

            // Выбираем N разных названий без повторений
            const shuffled = [...items].sort(() => Math.random() - 0.5);
            const picks = shuffled.slice(0, elementsCount).map((item) => {
                const qty = Math.floor(Math.random() * quantityMax) + 1;
                return { qty, text: item.text };
            });

            const parts = picks.map((p) => `${p.qty} ${p.text}`).join(' и ');
            const response = `Партия выдала ${parts} для @${user}`;

            await this.sendMessage(channel, response);

            if (!skipCooldown) {
            await query(
                `INSERT INTO party_cooldown (twitch_username, last_used_at)
                 VALUES ($1, CURRENT_TIMESTAMP)
                 ON CONFLICT (twitch_username) DO UPDATE SET last_used_at = CURRENT_TIMESTAMP`,
                [userNorm],
            );
            }

            console.log(`✅ Партия: ${parts} для ${user}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке !партия:', error);
            try {
                await this.sendMessage(channel, 'Ошибка партии, попробуй позже.');
            } catch {
                // ignore
            }
        }
    }

    /**
     * Обработка команды !команда / !команды / !commands
     * Отправляет в чат все включённые кастомные команды: триггер и ответ каждой
     */
    private async handleAllCommandsCommand(channel: string, user: string, msg: any) {
        console.log(`📋 Команда !команда от ${user} в ${channel}`);

        if (this.isAnnouncementOnCooldown('!команда')) {
            return;
        }

        try {
            const allCommands = await loadCustomCommandsFromDb();
            const enabled = allCommands.filter((c) => c.enabled);
            if (enabled.length === 0) {
                await this.sendMessage(channel, 'Нет включённых команд.');
                this.setAnnouncementCooldown('!команда');
                return;
            }

            const parts = enabled.map((cmd) => {
                const trigger = cmd.trigger.startsWith('!') ? cmd.trigger : `!${cmd.trigger}`;
                const aliases = (cmd.aliases ?? []).filter(Boolean);
                return aliases.length > 0 ? `${trigger} (${aliases.join(', ')})` : trigger;
            });

            const separator = ', ';
            const full = parts.join(separator);
            const maxLen = 480;

            // Сначала отдельной строкой заголовок
            await this.sendMessage(channel, '📋Список доступных команд в чате:');

            if (full.length <= maxLen) {
                await this.sendMessage(channel, full);
            } else {
                let chunk = '';
                for (const part of parts) {
                    const next = chunk ? chunk + separator + part : part;
                    if (next.length > maxLen && chunk) {
                        await this.sendMessage(channel, chunk);
                        chunk = part;
                    } else {
                        chunk = next;
                    }
                }
                if (chunk) {
                    await this.sendMessage(channel, chunk);
                }
            }

            this.setAnnouncementCooldown('!команда');
            console.log(`✅ Список команд (${enabled.length}) отправлен в чат`);
        } catch (error) {
            console.error('❌ Ошибка при отправке списка команд:', error);
        }
    }

    /**
     * Обработка команды !ссылки / !links
     * Отправляет список всех ссылочных команд отдельным сообщением
     */
    private async handleLinksCommand(channel: string, user: string, msg: any) {
        console.log(`🔗 Команда !ссылки от ${user} в ${channel}`);

        // Проверка cooldown
        if (this.isAnnouncementOnCooldown('!ссылки')) {
            return;
        }

        // Если в конфиге задан кастомный текст — используем его
        const trimmedConfig = (this.linksConfig.allLinksText || '').trim();
        let response: string;

        if (trimmedConfig.length > 0) {
            response = trimmedConfig;
        } else {
            // Фолбэк на старый хардкод, чтобы ничего не сломать
            const links = [
                '📸Boosty (запретные фото): https://boosty.to/kunilika911',
                '─────────────────',
                '😻Discord (тут я мурчу): https://discord.gg/zrNsn4vAw2',
                '─────────────────',
                '💖Donation (шанс, что приду): https://donatex.gg/donate/kunilika666',
                '─────────────────',
                '🔮Telegram (тайная жизнь): http://t.me/+rSBrR1FyQqBhZmU1',
                '─────────────────',
                '🎁Fetta (Ferrari для стримера): https://fetta.app/u/kunilika666'
            ];

            response = links.join(' ');
        }

        try {
            await this.sendMessage(channel, response);
            this.setAnnouncementCooldown('!ссылки');
            console.log(`✅ Список ссылок отправлен в чат`);
        } catch (error) {
            console.error('❌ Ошибка при отправке списка ссылок:', error);
        }
    }

    /**
     * Обработка команды !персонажи
     * Показывает список доступных публичных персонажей из Overlay API
     */
    private async handleCharactersListCommand(channel: string, user: string, msg: any) {
        console.log(`🎭 Команда !персонажи от ${user} в ${channel}`);

        try {
            const characters = await fetchOverlayCharacters();

            const response =
                characters.length === 0
                    ? 'Публичные персонажи пока не настроены.'
                    : `Доступные персонажи: ${characters.join(', ')}`;

            await this.sendMessage(channel, response);
            console.log(`✅ Список персонажей отправлен в чат`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !персонажи:', error);
            try {
                await this.sendMessage(
                    channel,
                    'Не удалось получить список персонажей :('
                );
            } catch {
                // игнорируем вторичную ошибку отправки
            }
        }
    }

    /**
     * Обработка команды !персонаж <имя>
     * Устанавливает публичного персонажа для пользователя в Overlay API
     */
    private async handleSetCharacterCommand(
        channel: string,
        user: string,
        message: string,
        msg: any
    ) {
        console.log(`🎭 Команда !персонаж от ${user} в ${channel}: ${message}`);

        const parts = message.trim().split(/\s+/);
        const character = parts[1];

        if (!character) {
            const usage =
                'Использование: !персонаж <имя>. Список доступных: !персонажи';
            try {
                await this.sendMessage(channel, usage);
            } catch (error) {
                console.error('❌ Ошибка отправки usage для !персонаж:', error);
            }
            return;
        }

        try {
            await setOverlayPlayerCharacter(user, character);
            const response = `@${user}, персонаж "${character}" установлен.`;
            await this.sendMessage(channel, response);
            console.log(`✅ Персонаж "${character}" установлен для ${user}`);
        } catch (error) {
            console.error('❌ Ошибка при обработке команды !персонаж:', error);
            try {
                await this.sendMessage(
                    channel,
                    `@${user}, не удалось установить персонажа "${character}".`
                );
            } catch {
                // игнорируем вторичную ошибку отправки
            }
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
     * Отправка объявления (Announcement) в чат Twitch через Helix API
     * @returns true если отправка успешна, false если ошибка
     */
    private async sendAnnouncement(message: string, color: 'blue' | 'green' | 'orange' | 'purple' | 'primary' = 'primary'): Promise<boolean> {
        if (!this.broadcasterId || !this.moderatorId) {
            console.error('❌ Нельзя отправить объявление: broadcasterId или moderatorId не инициализированы');
            return false;
        }

        try {
            await this.helix(
                `https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${this.broadcasterId}&moderator_id=${this.moderatorId}`,
                {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        message,
                        color
                    })
                },
                1 // для объявлений делаем только одну попытку, без повторов
            );
            console.log(`✅ Объявление отправлено (${color}):`, message);
            return true;
        } catch (error: any) {
            console.error(`⚠️ Ошибка отправки объявления (цвет: ${color}):`, error?.message || error);
            return false;
        }
    }

    /**
     * Получить случайный допустимый цвет объявления Twitch
     * 
     * Список цветов взят из официальной документации Twitch Helix API:
     * https://dev.twitch.tv/docs/api/reference/#send-chat-announcement
     * 
     * На данный момент (2024) поддерживаются только эти 5 цветов.
     * Если Twitch добавит новые цвета в будущем, API вернёт ошибку и fallback на 'primary'.
     */
    private getRandomAnnouncementColor(): 'blue' | 'green' | 'orange' | 'purple' | 'primary' {
        const colors: Array<'blue' | 'green' | 'orange' | 'purple' | 'primary'> = [
            'blue',
            'green',
            'orange',
            'purple',
            'primary'
        ];
        const idx = Math.floor(Math.random() * colors.length);
        return colors[idx];
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
     * Выключить все счётчики (вызывается при окончании стрима)
     */
    clearStopCounters(): void {
        query('UPDATE counters SET enabled = false WHERE id = $1', ['stop'])
            .then(() => {
                console.log('🧹 Счётчик !стоп выключен (можно включить вручную в веб для теста)');
                this.reloadCounters();
            })
            .catch((err) => {
                console.error('❌ Ошибка выключения счётчика !стоп:', err);
            });
        
        this.stopCounters.clear();
        this.saveCounters();
    }

    /**
     * Выключить счётчик смертей (вызывается при окончании стрима)
     */
    clearDeathCounters(): void {
        query('UPDATE counters SET enabled = false WHERE id = $1', ['death'])
            .then(() => {
                console.log('🧹 Счётчик !смерть выключен (можно включить вручную в веб для теста)');
                this.reloadCounters();
            })
            .catch((err) => {
                console.error('❌ Ошибка выключения счётчика !смерть:', err);
            });
        
        this.deathCounters.clear();
        this.saveCounters();
    }

    /**
     * Сбросить и включить игровые счётчики при начале стрима (только death и stop)
     */
    enableCountersOnStreamStart(): void {
        query('UPDATE counters SET enabled = true, value = 0 WHERE id IN ($1, $2)', ['death', 'stop'])
            .then(() => {
                console.log('✅ Игровые счётчики сброшены и включены: !смерть = 0, !стоп = 0 (стрим начался)');
                this.reloadCounters();
            })
            .catch((err) => {
                console.error('❌ Ошибка сброса счётчиков:', err);
            });
    }

    /**
     * Очистить список обнаруженных модераторов (вызывается при окончании стрима)
     * Нужно для актуализации прав - если модератора сняли, он не должен оставаться в списке админов
     */
    clearDetectedModerators(): void {
        this.detectedModerators.clear();
        setDuelAdminsFromModerators([]);
        console.log('🧹 Список обнаруженных модераторов очищен');
    }

    /**
     * Включить дуэли (для веб-интерфейса)
     */
    enableDuelsFromWeb(): void {
        enableDuelsFromWebApi();
    }

    /**
     * Выключить дуэли (для веб-интерфейса)
     */
    disableDuelsFromWeb(): void {
        disableDuelsFromWebApi();
    }

    /**
     * Амнистия - простить всех (для веб-интерфейса)
     */
    async pardonAllFromWeb(): Promise<void> {
        const result = await pardonAllDuelTimeoutsFromWeb();
        if (result.success) {
            console.log(`✅ Амнистия: снято таймаутов в БД - ${result.count}`);
            
            // Снимаем реальные таймауты в Twitch через API
            let unbannedCount = 0;
            for (const username of result.usernames) {
                const success = await this.untimeoutUser(username);
                if (success) {
                    unbannedCount++;
                }
            }
            
            console.log(`✅ Реальных таймаутов снято через Twitch API: ${unbannedCount}/${result.usernames.length}`);
        }
    }

    /**
     * Список игроков с таймаутом дуэли (для веб-интерфейса)
     */
    async getDuelBannedList(): Promise<{ username: string; timeoutUntil: number }[]> {
        return getDuelBannedPlayersFromWeb();
    }

    /**
     * Амнистия для одного игрока (снять таймаут в БД, в Twitch и оверлее)
     */
    async pardonDuelUser(username: string): Promise<void> {
        const result = await pardonDuelUserFromWeb(username);
        if (!result.success) return;
        await this.untimeoutUser(username);
        amnestyOverlayPlayer(username).catch((err: unknown) => {
            console.error('⚠️ Ошибка вызова Overlay amnesty для игрока:', username, err);
        });
    }

    /**
     * Получить статус дуэлей (для веб-интерфейса)
     */
    getDuelsStatus(): boolean {
        return areDuelsEnabled();
    }

    /**
     * Получить/установить режим «без КД» для дуэлей (для тестов)
     */
    getDuelCooldownSkip(): boolean {
        return getDuelCooldownSkipped();
    }

    setDuelCooldownSkip(skip: boolean): void {
        setDuelCooldownSkipped(skip);
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
            this.chatClient = null;
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
