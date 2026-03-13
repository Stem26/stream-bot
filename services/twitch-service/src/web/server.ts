import express, { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne } from '../database/database';

const app = express();
const PORT = process.env.WEB_PORT || 3000;

// Пути к файлам/данным
// Команды теперь хранятся в БД (таблица custom_commands),
// а конфиг ссылок пока остаётся в JSON файле.
const DATA_DIR = path.resolve(process.cwd(), 'src/data');
const LINKS_FILE = path.join(DATA_DIR, 'links-config.json');

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Интерфейс команды
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

interface CommandsData {
    commands: CustomCommand[];
}

interface LinksConfig {
    allLinksText: string;
}

interface Counter {
    id: string;
    trigger: string;
    aliases: string[];
    responseTemplate: string;
    value: number;
    enabled: boolean;
    description: string;
}

interface CountersData {
    counters: Counter[];
}

// === Работа с командами через БД ===

type DbCommandRow = {
    id: string;
    trigger: string;
    aliases: string[] | null;
    response: string;
    enabled: boolean;
    cooldown: number;
    message_type: string;
    color: string;
    description: string;
};

function mapDbRowToCommand(row: DbCommandRow): CustomCommand {
    return {
        id: row.id,
        trigger: row.trigger,
        aliases: row.aliases ?? [],
        response: row.response,
        enabled: row.enabled,
        cooldown: row.cooldown,
        messageType: (row.message_type as CustomCommand['messageType']) ?? 'announcement',
        color: (row.color as CustomCommand['color']) ?? 'primary',
        description: row.description ?? '',
    };
}

async function getAllCommandsFromDb(): Promise<CommandsData> {
    const rows = await query<DbCommandRow>(
        'SELECT id, trigger, aliases, response, enabled, cooldown, message_type, color, description FROM custom_commands ORDER BY id',
    );
    return { commands: rows.map(mapDbRowToCommand) };
}

async function getCommandByIdFromDb(id: string): Promise<CustomCommand | null> {
    const row = await queryOne<DbCommandRow>(
        'SELECT id, trigger, aliases, response, enabled, cooldown, message_type, color, description FROM custom_commands WHERE id = $1',
        [id],
    );
    return row ? mapDbRowToCommand(row) : null;
}

async function createCommandInDb(cmd: CustomCommand): Promise<void> {
    await query(
        `INSERT INTO custom_commands
          (id, trigger, aliases, response, enabled, cooldown, message_type, color, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
            cmd.id,
            cmd.trigger,
            cmd.aliases ?? [],
            cmd.response,
            cmd.enabled ?? true,
            cmd.cooldown ?? 10,
            cmd.messageType ?? 'announcement',
            cmd.color ?? 'primary',
            cmd.description ?? '',
        ],
    );
}

async function updateCommandInDb(id: string, partial: Partial<CustomCommand>): Promise<CustomCommand | null> {
    const existing = await getCommandByIdFromDb(id);
    if (!existing) {
        return null;
    }
    const merged: CustomCommand = {
        ...existing,
        ...partial,
        id: existing.id,
        aliases: partial.aliases ?? existing.aliases,
    };

    await query(
        `UPDATE custom_commands
         SET trigger = $2,
             aliases = $3,
             response = $4,
             enabled = $5,
             cooldown = $6,
             message_type = $7,
             color = $8,
             description = $9
         WHERE id = $1`,
        [
            merged.id,
            merged.trigger,
            merged.aliases ?? [],
            merged.response,
            merged.enabled,
            merged.cooldown,
            merged.messageType,
            merged.color,
            merged.description ?? '',
        ],
    );

    return merged;
}

async function deleteCommandInDb(id: string): Promise<boolean> {
    const result = await query<{ affected_rows: number }>('DELETE FROM custom_commands WHERE id = $1', [id]);
    // pg не возвращает affected_rows по умолчанию, поэтому просто считаем, что если нет ошибки — ок
    return true;
}

async function toggleCommandInDb(id: string): Promise<CustomCommand | null> {
    const existing = await getCommandByIdFromDb(id);
    if (!existing) return null;

    const newEnabled = !existing.enabled;
    await query('UPDATE custom_commands SET enabled = $2 WHERE id = $1', [id, newEnabled]);
    return { ...existing, enabled: newEnabled };
}

// === Работа со счётчиками через БД ===

type DbCounterRow = {
    id: string;
    trigger: string;
    aliases: string[] | null;
    response_template: string;
    value: number;
    enabled: boolean;
    description: string;
};

function mapDbRowToCounter(row: DbCounterRow): Counter {
    return {
        id: row.id,
        trigger: row.trigger,
        aliases: row.aliases ?? [],
        responseTemplate: row.response_template,
        value: row.value,
        enabled: row.enabled,
        description: row.description ?? '',
    };
}

async function getAllCountersFromDb(): Promise<CountersData> {
    const rows = await query<DbCounterRow>(
        'SELECT id, trigger, aliases, response_template, value, enabled, description FROM counters ORDER BY id',
    );
    return { counters: rows.map(mapDbRowToCounter) };
}

async function getCounterByIdFromDb(id: string): Promise<Counter | null> {
    const row = await queryOne<DbCounterRow>(
        'SELECT id, trigger, aliases, response_template, value, enabled, description FROM counters WHERE id = $1',
        [id],
    );
    return row ? mapDbRowToCounter(row) : null;
}

async function createCounterInDb(counter: Counter): Promise<void> {
    await query(
        `INSERT INTO counters
          (id, trigger, aliases, response_template, value, enabled, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            counter.id,
            counter.trigger,
            counter.aliases ?? [],
            counter.responseTemplate,
            counter.value ?? 0,
            counter.enabled ?? true,
            counter.description ?? '',
        ],
    );
}

async function updateCounterInDb(id: string, partial: Partial<Counter>): Promise<Counter | null> {
    const existing = await getCounterByIdFromDb(id);
    if (!existing) {
        return null;
    }
    const merged: Counter = {
        ...existing,
        ...partial,
        id: existing.id,
        aliases: partial.aliases ?? existing.aliases,
    };

    await query(
        `UPDATE counters
         SET trigger = $2,
             aliases = $3,
             response_template = $4,
             value = $5,
             enabled = $6,
             description = $7
         WHERE id = $1`,
        [
            merged.id,
            merged.trigger,
            merged.aliases ?? [],
            merged.responseTemplate,
            merged.value,
            merged.enabled,
            merged.description ?? '',
        ],
    );

    return merged;
}

async function deleteCounterInDb(id: string): Promise<boolean> {
    await query('DELETE FROM counters WHERE id = $1', [id]);
    return true;
}

async function toggleCounterInDb(id: string): Promise<Counter | null> {
    const existing = await getCounterByIdFromDb(id);
    if (!existing) return null;

    const newEnabled = !existing.enabled;
    await query('UPDATE counters SET enabled = $2 WHERE id = $1', [id, newEnabled]);
    return { ...existing, enabled: newEnabled };
}

async function incrementCounterInDb(id: string): Promise<Counter | null> {
    const existing = await getCounterByIdFromDb(id);
    if (!existing) return null;

    const newValue = existing.value + 1;
    await query('UPDATE counters SET value = $2 WHERE id = $1', [id, newValue]);
    return { ...existing, value: newValue };
}

function loadLinks(): LinksConfig {
    try {
        if (fs.existsSync(LINKS_FILE)) {
            const data = fs.readFileSync(LINKS_FILE, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('⚠️ Ошибка загрузки links-config:', error);
    }
    return {
        allLinksText: ''
    };
}

function saveLinks(config: LinksConfig): boolean {
    try {
        const dir = path.dirname(LINKS_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(LINKS_FILE, JSON.stringify(config, null, 2), 'utf-8');
        return true;
    } catch (error) {
        console.error('⚠️ Ошибка сохранения links-config:', error);
        return false;
    }
}

// === API Routes ===

// Получить все команды
app.get('/api/commands', async (req: Request, res: Response) => {
    try {
        const data = await getAllCommandsFromDb();
        res.json(data);
    } catch (error) {
        console.error('❌ Ошибка загрузки команд:', error);
        res.status(500).json({ error: 'Ошибка загрузки команд' });
    }
});

// === API для блока "Все ссылки" ===

app.get('/api/links', (req: Request, res: Response) => {
    try {
        const config = loadLinks();
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка загрузки ссылок' });
    }
});

app.put('/api/links', (req: Request, res: Response) => {
    try {
        const { allLinksText } = req.body as Partial<LinksConfig>;

        if (typeof allLinksText !== 'string') {
            return res.status(400).json({ error: 'Поле allLinksText обязательно' });
        }

        const config: LinksConfig = { allLinksText };

        if (saveLinks(config)) {
            console.log('✅ Конфиг ссылок обновлён');
            // Уведомляем Twitch-сервис, чтобы он тут же перечитал конфиг
            notifyCommandsChanged();
            res.json(config);
        } else {
            res.status(500).json({ error: 'Ошибка сохранения ссылок' });
        }
    } catch (error) {
        console.error('❌ Ошибка обновления ссылок:', error);
        res.status(500).json({ error: 'Ошибка обновления ссылок' });
    }
});

// Получить одну команду по ID
app.get('/api/commands/:id', async (req: Request, res: Response) => {
    try {
        const command = await getCommandByIdFromDb(req.params.id);

        if (!command) {
            return res.status(404).json({ error: 'Команда не найдена' });
        }

        res.json(command);
    } catch (error) {
        console.error('❌ Ошибка загрузки команды:', error);
        res.status(500).json({ error: 'Ошибка загрузки команды' });
    }
});

// Создать новую команду
app.post('/api/commands', async (req: Request, res: Response) => {
    try {
        const newCommand: CustomCommand = req.body;

        // Валидация
        if (!newCommand.id || !newCommand.trigger || !newCommand.response) {
            return res.status(400).json({ error: 'Обязательные поля: id, trigger, response' });
        }

        // Проверка на дубликат ID
        const existingById = await getCommandByIdFromDb(newCommand.id);
        if (existingById) {
            return res.status(400).json({ error: 'Команда с таким ID уже существует' });
        }

        // Проверка на дубликат trigger/alias
        const triggerCheck = await queryOne<{ id: string }>(
            `SELECT id FROM custom_commands
             WHERE LOWER(trigger) = LOWER($1)
                OR EXISTS (
                  SELECT 1 FROM unnest(aliases) a WHERE LOWER(a) = LOWER($1)
             )`,
            [newCommand.trigger],
        );

        if (triggerCheck) {
            return res.status(400).json({
                error: `Триггер "${newCommand.trigger}" уже используется командой "${triggerCheck.id}"`,
            });
        }

        const toSave: CustomCommand = {
            ...newCommand,
            aliases: newCommand.aliases || [],
            enabled: newCommand.enabled !== false,
            cooldown: newCommand.cooldown || 10,
            messageType: newCommand.messageType || 'announcement',
            color: newCommand.color || 'primary',
        };

        await createCommandInDb(toSave);
        console.log(`✅ Команда "${toSave.id}" создана`);
        notifyCommandsChanged();
        res.status(201).json(toSave);
    } catch (error) {
        console.error('❌ Ошибка создания команды:', error);
        res.status(500).json({ error: 'Ошибка создания команды' });
    }
});

// Обновить команду
app.put('/api/commands/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const updatedCommand: Partial<CustomCommand> = req.body;

        const existing = await getCommandByIdFromDb(id);
        if (!existing) {
            return res.status(404).json({ error: 'Команда не найдена' });
        }

        // Если меняется trigger, проверяем на дубликаты
        if (updatedCommand.trigger && updatedCommand.trigger !== existing.trigger) {
            const existingTrigger = await queryOne<{ id: string }>(
                `SELECT id FROM custom_commands
                 WHERE id <> $1 AND (
                   LOWER(trigger) = LOWER($2)
                   OR EXISTS (
                     SELECT 1 FROM unnest(aliases) a WHERE LOWER(a) = LOWER($2)
                   )
                 )`,
                [id, updatedCommand.trigger],
            );

            if (existingTrigger) {
                return res.status(400).json({
                    error: `Триггер "${updatedCommand.trigger}" уже используется командой "${existingTrigger.id}"`,
                });
            }
        }

        const merged = await updateCommandInDb(id, updatedCommand);
        if (!merged) {
            return res.status(404).json({ error: 'Команда не найдена' });
        }

        console.log(`✅ Команда "${id}" обновлена`);
        notifyCommandsChanged();
        res.json(merged);
    } catch (error) {
        console.error('❌ Ошибка обновления команды:', error);
        res.status(500).json({ error: 'Ошибка обновления команды' });
    }
});

// Удалить команду
app.delete('/api/commands/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const existing = await getCommandByIdFromDb(id);
        if (!existing) {
            return res.status(404).json({ error: 'Команда не найдена' });
        }

        await deleteCommandInDb(id);
        console.log(`✅ Команда "${id}" удалена`);
        notifyCommandsChanged();
        res.json({ success: true, message: 'Команда удалена' });
    } catch (error) {
        console.error('❌ Ошибка удаления команды:', error);
        res.status(500).json({ error: 'Ошибка удаления команды' });
    }
});

// Переключить статус команды (enabled/disabled)
app.patch('/api/commands/:id/toggle', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const updated = await toggleCommandInDb(id);

        if (!updated) {
            return res.status(404).json({ error: 'Команда не найдена' });
        }

        console.log(`✅ Команда "${id}" ${updated.enabled ? 'включена' : 'отключена'}`);
        notifyCommandsChanged();
        res.json(updated);
    } catch (error) {
        console.error('❌ Ошибка переключения команды:', error);
        res.status(500).json({ error: 'Ошибка переключения команды' });
    }
});

// Ручной запуск команды (отправка в чат)
app.post('/api/commands/:id/send', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

    const command = await getCommandByIdFromDb(id);
    if (!command) {
      return res.status(404).json({ error: 'Команда не найдена' });
    }
    if (!command.enabled) {
      return res.status(400).json({ error: 'Команда выключена и не может быть отправлена' });
    }

        await executeCommandById(id);

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка ручного запуска команды:', error);
        res.status(500).json({ error: 'Ошибка ручного запуска команды' });
    }
});

// Ручная отправка текста всех ссылок (!ссылки) в чат
app.post('/api/links/send', async (req: Request, res: Response) => {
    try {
        await executeLinks();
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка ручной отправки ссылок:', error);
        res.status(500).json({ error: 'Ошибка отправки ссылок' });
    }
});

// === API для счётчиков ===

// Получить все счётчики
app.get('/api/counters', async (req: Request, res: Response) => {
    try {
        const data = await getAllCountersFromDb();
        res.json(data);
    } catch (error) {
        console.error('❌ Ошибка загрузки счётчиков:', error);
        res.status(500).json({ error: 'Ошибка загрузки счётчиков' });
    }
});

// Получить один счётчик по ID
app.get('/api/counters/:id', async (req: Request, res: Response) => {
    try {
        const counter = await getCounterByIdFromDb(req.params.id);

        if (!counter) {
            return res.status(404).json({ error: 'Счётчик не найден' });
        }

        res.json(counter);
    } catch (error) {
        console.error('❌ Ошибка загрузки счётчика:', error);
        res.status(500).json({ error: 'Ошибка загрузки счётчика' });
    }
});

// Создать новый счётчик
app.post('/api/counters', async (req: Request, res: Response) => {
    try {
        const newCounter: Counter = req.body;

        if (!newCounter.id || !newCounter.trigger || !newCounter.responseTemplate) {
            return res.status(400).json({ error: 'Обязательные поля: id, trigger, responseTemplate' });
        }

        const existingById = await getCounterByIdFromDb(newCounter.id);
        if (existingById) {
            return res.status(400).json({ error: 'Счётчик с таким ID уже существует' });
        }

        const triggerCheck = await queryOne<{ id: string }>(
            `SELECT id FROM counters
             WHERE LOWER(trigger) = LOWER($1)
                OR EXISTS (
                  SELECT 1 FROM unnest(aliases) a WHERE LOWER(a) = LOWER($1)
             )`,
            [newCounter.trigger],
        );

        if (triggerCheck) {
            return res.status(400).json({
                error: `Триггер "${newCounter.trigger}" уже используется счётчиком "${triggerCheck.id}"`,
            });
        }

        const toSave: Counter = {
            ...newCounter,
            aliases: newCounter.aliases || [],
            enabled: newCounter.enabled !== false,
            value: newCounter.value || 0,
        };

        await createCounterInDb(toSave);
        console.log(`✅ Счётчик "${toSave.id}" создан`);
        res.status(201).json(toSave);
    } catch (error) {
        console.error('❌ Ошибка создания счётчика:', error);
        res.status(500).json({ error: 'Ошибка создания счётчика' });
    }
});

// Обновить счётчик
app.put('/api/counters/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const updatedCounter: Partial<Counter> = req.body;

        const existing = await getCounterByIdFromDb(id);
        if (!existing) {
            return res.status(404).json({ error: 'Счётчик не найден' });
        }

        const merged = await updateCounterInDb(id, updatedCounter);
        if (!merged) {
            return res.status(404).json({ error: 'Счётчик не найден' });
        }

        console.log(`✅ Счётчик "${id}" обновлён`);
        res.json(merged);
    } catch (error) {
        console.error('❌ Ошибка обновления счётчика:', error);
        res.status(500).json({ error: 'Ошибка обновления счётчика' });
    }
});

// Удалить счётчик
app.delete('/api/counters/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const existing = await getCounterByIdFromDb(id);
        if (!existing) {
            return res.status(404).json({ error: 'Счётчик не найден' });
        }

        await deleteCounterInDb(id);
        console.log(`✅ Счётчик "${id}" удалён`);
        res.json({ success: true, message: 'Счётчик удалён' });
    } catch (error) {
        console.error('❌ Ошибка удаления счётчика:', error);
        res.status(500).json({ error: 'Ошибка удаления счётчика' });
    }
});

// Переключить статус счётчика
app.patch('/api/counters/:id/toggle', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const updated = await toggleCounterInDb(id);

        if (!updated) {
            return res.status(404).json({ error: 'Счётчик не найден' });
        }

        console.log(`✅ Счётчик "${id}" ${updated.enabled ? 'включён' : 'отключён'}`);
        res.json(updated);
    } catch (error) {
        console.error('❌ Ошибка переключения счётчика:', error);
        res.status(500).json({ error: 'Ошибка переключения счётчика' });
    }
});

// Инкрементировать счётчик
app.patch('/api/counters/:id/increment', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const updated = await incrementCounterInDb(id);

        if (!updated) {
            return res.status(404).json({ error: 'Счётчик не найден' });
        }

        console.log(`✅ Счётчик "${id}" увеличен до ${updated.value}`);
        res.json(updated);
    } catch (error) {
        console.error('❌ Ошибка инкремента счётчика:', error);
        res.status(500).json({ error: 'Ошибка инкремента счётчика' });
    }
});

// Корневой маршрут - отдаём HTML интерфейс
app.get('/', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Колбэки для связи с Twitch-сервисом
let onCommandsChangedCallback: (() => void) | null = null;
let onCommandExecuteCallback: ((id: string) => void | Promise<void>) | null = null;
let onLinksSendCallback: (() => void | Promise<void>) | null = null;

export function setOnCommandsChangedCallback(callback: () => void) {
    onCommandsChangedCallback = callback;
}

export function setOnCommandExecuteCallback(callback: (id: string) => void | Promise<void>) {
    onCommandExecuteCallback = callback;
}

export function setOnLinksSendCallback(callback: () => void | Promise<void>) {
    onLinksSendCallback = callback;
}

function notifyCommandsChanged() {
    if (onCommandsChangedCallback) {
        onCommandsChangedCallback();
        console.log('📢 Уведомление об изменении команд отправлено');
    }
}

async function executeCommandById(id: string): Promise<void> {
    if (!onCommandExecuteCallback) {
        throw new Error('onCommandExecuteCallback is not set');
    }
    await onCommandExecuteCallback(id);
}

async function executeLinks(): Promise<void> {
    if (!onLinksSendCallback) {
        throw new Error('onLinksSendCallback is not set');
    }
    await onLinksSendCallback();
}

// Запуск сервера
export function startWebServer(): Promise<void> {
    return new Promise((resolve) => {
        app.listen(PORT, () => {
            console.log(`🌐 Веб-интерфейс доступен: http://localhost:${PORT}`);
            resolve();
        });
    });
}

// Если запускается напрямую
if (require.main === module) {
    startWebServer().catch(console.error);
}
