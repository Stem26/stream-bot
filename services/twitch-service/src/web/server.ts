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

// === API для партии (список на выдачу, раз в сутки на пользователя) ===

type PartyItemRow = { id: number; text: string; sort_order: number };
type PartyConfigRow = { elements_count: number; quantity_max: number; skip_cooldown: boolean };

app.get('/api/party/config', async (req: Request, res: Response) => {
    try {
        const row = await queryOne<PartyConfigRow>(
            'SELECT elements_count, quantity_max, skip_cooldown FROM party_config WHERE id = 1',
        );
        res.json({
            elementsCount: row?.elements_count ?? 2,
            quantityMax: row?.quantity_max ?? 4,
            skipCooldown: row?.skip_cooldown ?? false,
        });
    } catch (error) {
        console.error('❌ Ошибка загрузки настроек партии:', error);
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

app.put('/api/party/config', async (req: Request, res: Response) => {
    try {
        const { elementsCount, quantityMax, skipCooldown } = req.body as {
            elementsCount?: number;
            quantityMax?: number;
            skipCooldown?: boolean;
        };
        const ec = Math.min(10, Math.max(1, Math.floor(Number(elementsCount) ?? 0) || 1));
        const qm = Math.min(99, Math.max(1, Math.floor(Number(quantityMax) ?? 0) || 1));
        const sc = Boolean(skipCooldown);
        await query(
            'UPDATE party_config SET elements_count = $1, quantity_max = $2, skip_cooldown = $3 WHERE id = 1',
            [ec, qm, sc],
        );
        res.json({ elementsCount: ec, quantityMax: qm, skipCooldown: sc });
    } catch (error) {
        console.error('❌ Ошибка сохранения настроек партии:', error);
        res.status(500).json({ error: 'Ошибка сохранения' });
    }
});

app.patch('/api/party/config/skip-cooldown', async (req: Request, res: Response) => {
    try {
        const { skipCooldown } = req.body as { skipCooldown?: boolean };
        const sc = Boolean(skipCooldown);
        await query('UPDATE party_config SET skip_cooldown = $1 WHERE id = 1', [sc]);
        res.json({ skipCooldown: sc });
    } catch (error) {
        console.error('❌ Ошибка переключения skip_cooldown:', error);
        res.status(500).json({ error: 'Ошибка' });
    }
});

app.get('/api/party/items', async (req: Request, res: Response) => {
    try {
        const rows = await query<PartyItemRow>(
            'SELECT id, text, sort_order FROM party_items ORDER BY sort_order, id',
        );
        res.json({ items: rows });
    } catch (error) {
        console.error('❌ Ошибка загрузки партии:', error);
        res.status(500).json({ error: 'Ошибка загрузки партии' });
    }
});

app.post('/api/party/items', async (req: Request, res: Response) => {
    try {
        const { text } = req.body as { text: string };
        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'Поле text обязательно' });
        }
        const maxOrder = await queryOne<{ max: number | null }>(
            'SELECT MAX(sort_order) AS max FROM party_items',
        );
        const sortOrder = (maxOrder?.max ?? -1) + 1;
        const result = await query<PartyItemRow>(
            'INSERT INTO party_items (text, sort_order) VALUES ($1, $2) RETURNING id, text, sort_order',
            [text.trim(), sortOrder],
        );
        res.status(201).json(result[0]);
    } catch (error) {
        console.error('❌ Ошибка добавления элемента партии:', error);
        res.status(500).json({ error: 'Ошибка добавления' });
    }
});

app.put('/api/party/items/:id', async (req: Request, res: Response) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Некорректный id' });
        const { text } = req.body as { text?: string };
        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'Поле text обязательно' });
        }
        const result = await query<PartyItemRow>(
            'UPDATE party_items SET text = $2 WHERE id = $1 RETURNING id, text, sort_order',
            [id, text.trim()],
        );
        if (result.length === 0) return res.status(404).json({ error: 'Элемент не найден' });
        res.json(result[0]);
    } catch (error) {
        console.error('❌ Ошибка обновления элемента партии:', error);
        res.status(500).json({ error: 'Ошибка обновления' });
    }
});

app.delete('/api/party/items/:id', async (req: Request, res: Response) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Некорректный id' });
        await query('DELETE FROM party_items WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка удаления элемента партии:', error);
        res.status(500).json({ error: 'Ошибка удаления' });
    }
});

// === API для таблицы лидеров (публичное) ===

app.get('/api/leaderboard', async (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 100;
        const offset = (page - 1) * limit;

        const streamerUsername = (process.env.TWITCH_CHANNEL || 'kunilika666').toLowerCase();

        // Количество для пагинации (без стримера)
        const totalResult = await queryOne<{ count: string }>(
            `SELECT COUNT(*) as count
             FROM twitch_player_stats
             WHERE (points > 0 OR duel_wins > 0) AND LOWER(twitch_username) != $1`,
            [streamerUsername]
        );
        const total = parseInt(totalResult?.count || '0', 10);

        // Стример — всегда отдельно, сверху
        const streamerRow = await queryOne<any>(
            `SELECT twitch_username, COALESCE(points, 0) as points,
                    COALESCE(duel_wins, 0) as duel_wins,
                    COALESCE(duel_losses, 0) as duel_losses,
                    COALESCE(duel_draws, 0) as duel_draws
             FROM twitch_player_stats
             WHERE LOWER(twitch_username) = $1 AND (points > 0 OR duel_wins > 0)`,
            [streamerUsername]
        );

        // Таблица без стримера (чтобы не дублировать)
        const players = await query<any>(
            `SELECT twitch_username, 
                    COALESCE(points, 0) as points,
                    COALESCE(duel_wins, 0) as duel_wins,
                    COALESCE(duel_losses, 0) as duel_losses,
                    COALESCE(duel_draws, 0) as duel_draws
             FROM twitch_player_stats
             WHERE (points > 0 OR duel_wins > 0) AND LOWER(twitch_username) != $1
             ORDER BY points DESC, duel_wins DESC
             LIMIT $2 OFFSET $3`,
            [streamerUsername, limit, offset]
        );
        
        res.json({ 
            players,
            streamerPlayer: streamerRow ?? null,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('❌ Ошибка загрузки таблицы лидеров:', error);
        res.status(500).json({ error: 'Ошибка загрузки таблицы' });
    }
});

// === API для авторизации ===

app.post('/api/auth/login', (req: Request, res: Response) => {
    try {
        const { password } = req.body;
        const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
        
        if (password === adminPassword) {
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, error: 'Неверный пароль' });
        }
    } catch (error) {
        console.error('❌ Ошибка авторизации:', error);
        res.status(500).json({ error: 'Ошибка авторизации' });
    }
});

// === API для админ-панели ===

// Получить статус дуэлей
app.get('/api/admin/duels/status', (req: Request, res: Response) => {
    try {
        const enabled = getDuelsStatus();
        res.json({ enabled });
    } catch (error) {
        console.error('❌ Ошибка получения статуса дуэлей:', error);
        res.status(500).json({ error: 'Ошибка получения статуса' });
    }
});

// Включить дуэли
app.post('/api/admin/duels/enable', async (req: Request, res: Response) => {
    try {
        await executeEnableDuels();
        res.json({ success: true, message: 'Дуэли включены' });
    } catch (error) {
        console.error('❌ Ошибка включения дуэлей:', error);
        res.status(500).json({ error: 'Ошибка включения дуэлей' });
    }
});

// Выключить дуэли
app.post('/api/admin/duels/disable', async (req: Request, res: Response) => {
    try {
        await executeDisableDuels();
        res.json({ success: true, message: 'Дуэли выключены' });
    } catch (error) {
        console.error('❌ Ошибка выключения дуэлей:', error);
        res.status(500).json({ error: 'Ошибка выключения дуэлей' });
    }
});

// Амнистия - снять все таймауты
app.post('/api/admin/pardon-all', async (req: Request, res: Response) => {
    try {
        await executePardonAll();
        res.json({ success: true, message: 'Амнистия выполнена' });
    } catch (error) {
        console.error('❌ Ошибка амнистии:', error);
        res.status(500).json({ error: 'Ошибка выполнения амнистии' });
    }
});

// === Публичные страницы ===

// Главная страница - редирект на /public
app.get('/', (req: Request, res: Response) => {
    res.redirect('/public');
});

// Публичная главная
app.get('/public', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'public-home.html'));
});

// Таблица лидеров
app.get('/public/duel', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'public-duel.html'));
});

// Страница со ссылками
app.get('/public/links', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'public-links.html'));
});

// === Админ-панель (защищена Nginx Basic Auth) ===
app.get('/admin', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// OAuth — страница для получения Twitch токена с полными scope
app.get('/oauth', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'twitch-oauth.html'));
});

// Колбэки для связи с Twitch-сервисом
let onCommandsChangedCallback: (() => void) | null = null;
let onCommandExecuteCallback: ((id: string) => void | Promise<void>) | null = null;
let onLinksSendCallback: (() => void | Promise<void>) | null = null;
let onEnableDuelsCallback: (() => void | Promise<void>) | null = null;
let onDisableDuelsCallback: (() => void | Promise<void>) | null = null;
let onPardonAllCallback: (() => void | Promise<void>) | null = null;
let getDuelsStatusCallback: (() => boolean) | null = null;

export function setOnCommandsChangedCallback(callback: () => void) {
    onCommandsChangedCallback = callback;
}

export function setOnCommandExecuteCallback(callback: (id: string) => void | Promise<void>) {
    onCommandExecuteCallback = callback;
}

export function setOnLinksSendCallback(callback: () => void | Promise<void>) {
    onLinksSendCallback = callback;
}

export function setOnEnableDuelsCallback(callback: () => void | Promise<void>) {
    onEnableDuelsCallback = callback;
}

export function setOnDisableDuelsCallback(callback: () => void | Promise<void>) {
    onDisableDuelsCallback = callback;
}

export function setOnPardonAllCallback(callback: () => void | Promise<void>) {
    onPardonAllCallback = callback;
}

export function setGetDuelsStatusCallback(callback: () => boolean) {
    getDuelsStatusCallback = callback;
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

async function executeEnableDuels(): Promise<void> {
    if (!onEnableDuelsCallback) {
        throw new Error('onEnableDuelsCallback is not set');
    }
    await onEnableDuelsCallback();
}

async function executeDisableDuels(): Promise<void> {
    if (!onDisableDuelsCallback) {
        throw new Error('onDisableDuelsCallback is not set');
    }
    await onDisableDuelsCallback();
}

async function executePardonAll(): Promise<void> {
    if (!onPardonAllCallback) {
        throw new Error('onPardonAllCallback is not set');
    }
    await onPardonAllCallback();
}

function getDuelsStatus(): boolean {
    if (!getDuelsStatusCallback) {
        return false;
    }
    return getDuelsStatusCallback();
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
