import express, { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import WebSocket from 'ws';
import { query, queryOne } from '../database/database';

const app = express();
const PORT = process.env.WEB_PORT || 3000;

// WebSocket для реал-тайм обновлений (например, список забаненных по дуэлям) — только по событиям (дуэль/амнистия)
const WS_PATH = '/ws';
let wss: WebSocket.Server | null = null;
let broadcastDuelBannedChanged: (() => void) | null = null;

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
    inRotation: boolean;
}

interface CommandsData {
    commands: CustomCommand[];
}

interface LinksConfig {
    allLinksText: string;
    rotationIntervalMinutes: number;
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
    in_rotation: boolean;
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
        inRotation: row.in_rotation ?? false,
    };
}

async function getAllCommandsFromDb(): Promise<CommandsData> {
    const rows = await query<DbCommandRow>(
        'SELECT id, trigger, aliases, response, enabled, cooldown, message_type, color, description, in_rotation FROM custom_commands ORDER BY id',
    );
    return { commands: rows.map(mapDbRowToCommand) };
}

async function getCommandByIdFromDb(id: string): Promise<CustomCommand | null> {
    const row = await queryOne<DbCommandRow>(
        'SELECT id, trigger, aliases, response, enabled, cooldown, message_type, color, description, in_rotation FROM custom_commands WHERE id = $1',
        [id],
    );
    return row ? mapDbRowToCommand(row) : null;
}

async function createCommandInDb(cmd: CustomCommand): Promise<void> {
    await query(
        `INSERT INTO custom_commands
          (id, trigger, aliases, response, enabled, cooldown, message_type, color, description, in_rotation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
            cmd.inRotation ?? false,
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

    const mergedWithRotation = { ...merged, inRotation: partial.inRotation ?? existing.inRotation };
    await query(
        `UPDATE custom_commands
         SET trigger = $2,
             aliases = $3,
             response = $4,
             enabled = $5,
             cooldown = $6,
             message_type = $7,
             color = $8,
             description = $9,
             in_rotation = $10
         WHERE id = $1`,
        [
            mergedWithRotation.id,
            mergedWithRotation.trigger,
            mergedWithRotation.aliases ?? [],
            mergedWithRotation.response,
            mergedWithRotation.enabled,
            mergedWithRotation.cooldown,
            mergedWithRotation.messageType,
            mergedWithRotation.color,
            mergedWithRotation.description ?? '',
            mergedWithRotation.inRotation,
        ],
    );
    return mergedWithRotation;
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

async function toggleCommandRotationInDb(id: string): Promise<CustomCommand | null> {
    const existing = await getCommandByIdFromDb(id);
    if (!existing) return null;

    const newInRotation = !existing.inRotation;
    await query('UPDATE custom_commands SET in_rotation = $2 WHERE id = $1', [id, newInRotation]);
    return { ...existing, inRotation: newInRotation };
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

async function getLinksFromDb(): Promise<LinksConfig> {
    try {
        const row = await queryOne<{ all_links_text: string; rotation_interval_minutes: number }>(
            'SELECT all_links_text, rotation_interval_minutes FROM links_config WHERE id = 1'
        );
        return {
            allLinksText: row?.all_links_text ?? '',
            rotationIntervalMinutes: row?.rotation_interval_minutes ?? 13,
        };
    } catch (error) {
        console.error('⚠️ Ошибка загрузки links_config из БД:', error);
        return { allLinksText: '', rotationIntervalMinutes: 13 };
    }
}

async function saveLinksToDb(config: LinksConfig): Promise<boolean> {
    try {
        const interval = config.rotationIntervalMinutes ?? 13;
        await query(
            `INSERT INTO links_config (id, all_links_text, rotation_interval_minutes) VALUES (1, $1, $2)
             ON CONFLICT (id) DO UPDATE SET all_links_text = EXCLUDED.all_links_text, rotation_interval_minutes = EXCLUDED.rotation_interval_minutes`,
            [config.allLinksText, interval]
        );
        return true;
    } catch (error) {
        console.error('⚠️ Ошибка сохранения links_config в БД:', error);
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

// === API для блока "Все ссылки" (хранится в БД links_config) ===

app.get('/api/links', async (req: Request, res: Response) => {
    try {
        const config = await getLinksFromDb();
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка загрузки ссылок' });
    }
});

app.put('/api/links', async (req: Request, res: Response) => {
    try {
        const { allLinksText, rotationIntervalMinutes } = req.body as Partial<LinksConfig>;

        if (typeof allLinksText !== 'string') {
            return res.status(400).json({ error: 'Поле allLinksText обязательно' });
        }

        // Если минут нет в теле запроса — не трогаем интервал, берём текущее значение из БД
        let effectiveInterval: number;
        if (typeof rotationIntervalMinutes === 'number') {
            effectiveInterval = rotationIntervalMinutes;
        } else {
            const current = await getLinksFromDb();
            effectiveInterval = current.rotationIntervalMinutes ?? 13;
        }

        const config: LinksConfig = {
            allLinksText,
            rotationIntervalMinutes: effectiveInterval,
        };

        if (await saveLinksToDb(config)) {
            console.log('✅ Конфиг ссылок обновлён (БД)');
            notifyCommandsChanged();
            if (onLinksConfigUpdatedCallback) {
                try {
                    onLinksConfigUpdatedCallback(config);
                } catch (cbError) {
                    console.error('⚠️ Ошибка в onLinksConfigUpdatedCallback:', cbError);
                }
            }
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

// Переключить участие команды в ротации ссылок (in_rotation)
app.patch('/api/commands/:id/rotation-toggle', async (req: Request, res: Response) => {
    try {
        const id = req.params.id;
        if (!id) {
            return res.status(400).json({ error: 'ID команды не указан' });
        }
        const updated = await toggleCommandRotationInDb(id);

        if (!updated) {
            return res.status(404).json({ error: 'Команда не найдена' });
        }

        console.log(`✅ Команда "${id}" ${updated.inRotation ? 'добавлена в ротацию' : 'убрана из ротации'}`);
        notifyCommandsChanged();
        res.json(updated);
    } catch (error: any) {
        const message = error?.message || 'Ошибка переключения ротации команды';
        console.error('❌ Ошибка переключения ротации команды:', error);
        res.status(500).json({ error: message });
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
type PartyConfigRow = { enabled: boolean; trigger: string; response_text: string; elements_count: number; quantity_max: number; skip_cooldown: boolean };
let onPartyConfigUpdatedCallback: (() => void) | null = null;

app.get('/api/party/config', async (req: Request, res: Response) => {
    try {
        const row = await queryOne<PartyConfigRow>(
            'SELECT trigger, response_text, elements_count, quantity_max, skip_cooldown FROM party_config WHERE id = 1',
        );
        res.json({
            trigger: row?.trigger ?? '!партия',
            responseText: row?.response_text ?? 'Партия выдала',
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
        const { enabled, trigger, responseText, elementsCount, quantityMax, skipCooldown } = req.body as {
            enabled?: boolean;
            trigger?: string;
            responseText?: string;
            elementsCount?: number;
            quantityMax?: number;
            skipCooldown?: boolean;
        };
        const tr = (trigger != null && String(trigger).trim()) ? String(trigger).trim() : undefined;
        const rt = (responseText != null && String(responseText).trim()) ? String(responseText).trim() : undefined;
        const ec = Math.min(10, Math.max(1, Math.floor(Number(elementsCount) ?? 0) || 1));
        const qm = Math.min(99, Math.max(1, Math.floor(Number(quantityMax) ?? 0) || 1));
        const sc = Boolean(skipCooldown);
        const updates: string[] = ['elements_count = $1', 'quantity_max = $2', 'skip_cooldown = $3'];
        const params: unknown[] = [ec, qm, sc];
        let i = 4;
        if (typeof enabled === 'boolean') {
            updates.push(`enabled = $${i++}`);
            params.push(enabled);
        }
        if (tr !== undefined) {
            updates.push(`trigger = $${i++}`);
            params.push(tr.startsWith('!') ? tr : `!${tr}`);
        }
        if (rt !== undefined) {
            updates.push(`response_text = $${i++}`);
            params.push(rt);
        }
        await query(
            `UPDATE party_config SET ${updates.join(', ')} WHERE id = 1`,
            params as number[],
        );
        if (onPartyConfigUpdatedCallback) onPartyConfigUpdatedCallback();
        const row = await queryOne<PartyConfigRow>(
            'SELECT enabled, trigger, response_text, elements_count, quantity_max, skip_cooldown FROM party_config WHERE id = 1',
        );
        const enabledVal = row?.enabled ?? true;
        console.log(`[Партия] Сохранено: Партия=${enabledVal ? 'ВКЛ' : 'ВЫКЛ'}, триггер=${row?.trigger ?? '!партия'}`);
        res.json({
            enabled: enabledVal,
            trigger: row?.trigger ?? '!партия',
            responseText: row?.response_text ?? 'Партия выдала',
            elementsCount: row?.elements_count ?? 2,
            quantityMax: row?.quantity_max ?? 4,
            skipCooldown: row?.skip_cooldown ?? false,
        });
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
        const sort = (req.query.sort as string) || 'points';
        const order = (req.query.order as string) === 'asc' ? 'ASC' : 'DESC';
        const offset = (page - 1) * limit;

        const sortColumn = ['points', 'wins', 'losses', 'draws'].includes(sort)
            ? { points: 'points', wins: 'duel_wins', losses: 'duel_losses', draws: 'duel_draws' }[sort]
            : 'points';

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
             ORDER BY ${sortColumn} ${order}, points DESC, duel_wins DESC
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

// Получить статус дуэлей (включены + режим КД)
app.get('/api/admin/duels/status', (req: Request, res: Response) => {
    try {
        const enabled = getDuelsStatus();
        const skipCooldown = getDuelCooldownSkipCallback ? getDuelCooldownSkipCallback() : false;
        res.json({ enabled, skipCooldown });
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

// Вкл/выкл КД 1 мин (для тестов — без КД можно спамить дуэли)
app.post('/api/admin/duels/set-cooldown-skip', (req: Request, res: Response) => {
    try {
        const skip = Boolean(req.body?.skip);
        if (setDuelCooldownSkipCallback) setDuelCooldownSkipCallback(skip);
        res.json({ success: true, skipCooldown: skip });
    } catch (error) {
        console.error('❌ Ошибка установки режима КД:', error);
        res.status(500).json({ error: 'Ошибка установки режима КД' });
    }
});

// Настройки модерации чата (анти-спам)
type ChatModerationRow = {
    moderation_enabled: boolean;
    check_symbols: boolean;
    check_letters: boolean;
    max_message_length: number;
    max_letters_digits: number;
    timeout_minutes: number;
};

const defaultModerationConfig = () => ({
    moderationEnabled: true,
    checkSymbols: true,
    checkLetters: true,
    maxMessageLength: 300,
    maxLettersDigits: 300,
    timeoutMinutes: 10,
});

app.get('/api/admin/chat-moderation/config', async (_req: Request, res: Response) => {
    try {
        const row = await queryOne<ChatModerationRow>(
            'SELECT moderation_enabled, check_symbols, check_letters, max_message_length, max_letters_digits, timeout_minutes FROM chat_moderation_config WHERE id = 1'
        );
        if (!row) {
            res.json(defaultModerationConfig());
            return;
        }
        res.json({
            moderationEnabled: row.moderation_enabled ?? true,
            checkSymbols: row.check_symbols ?? true,
            checkLetters: row.check_letters ?? true,
            maxMessageLength: row.max_message_length,
            maxLettersDigits: row.max_letters_digits ?? 300,
            timeoutMinutes: row.timeout_minutes,
        });
    } catch (error) {
        console.error('❌ Ошибка получения конфига модерации чата:', error);
        res.status(500).json({ error: 'Ошибка получения конфига модерации чата' });
    }
});

app.post('/api/admin/chat-moderation/config', async (req: Request, res: Response) => {
    try {
        const moderationEnabled =
            req.body?.moderationEnabled != null ? Boolean(req.body.moderationEnabled) : undefined;
        const checkSymbols =
            req.body?.checkSymbols != null ? Boolean(req.body.checkSymbols) : undefined;
        const checkLetters =
            req.body?.checkLetters != null ? Boolean(req.body.checkLetters) : undefined;
        const maxMessageLength =
            req.body?.maxMessageLength != null ? Number(req.body.maxMessageLength) : undefined;
        const maxLettersDigits =
            req.body?.maxLettersDigits != null ? Number(req.body.maxLettersDigits) : undefined;
        const timeoutMinutes =
            req.body?.timeoutMinutes != null ? Number(req.body.timeoutMinutes) : undefined;

        if (
            (maxMessageLength != null &&
                (Number.isNaN(maxMessageLength) || maxMessageLength < 1)) ||
            (maxLettersDigits != null &&
                (Number.isNaN(maxLettersDigits) || maxLettersDigits < 1)) ||
            (timeoutMinutes != null &&
                (Number.isNaN(timeoutMinutes) || timeoutMinutes < 1))
        ) {
            res.status(400).json({
                error: 'Значения должны быть положительными числами',
            });
            return;
        }

        const updates: string[] = [];
        const params: unknown[] = [];
        let i = 1;

        if (moderationEnabled != null) {
            updates.push(`moderation_enabled = $${i++}`);
            params.push(moderationEnabled);
            if (!moderationEnabled) {
                updates.push(`check_symbols = $${i++}`);
                params.push(false);
                updates.push(`check_letters = $${i++}`);
                params.push(false);
            }
        }
        if (checkSymbols != null && moderationEnabled !== false) {
            updates.push(`check_symbols = $${i++}`);
            params.push(checkSymbols);
        }
        if (checkLetters != null && moderationEnabled !== false) {
            updates.push(`check_letters = $${i++}`);
            params.push(checkLetters);
        }
        if (maxMessageLength != null) {
            updates.push(`max_message_length = $${i++}`);
            params.push(maxMessageLength);
        }
        if (maxLettersDigits != null) {
            updates.push(`max_letters_digits = $${i++}`);
            params.push(maxLettersDigits);
        }
        if (timeoutMinutes != null) {
            updates.push(`timeout_minutes = $${i++}`);
            params.push(timeoutMinutes);
        }

        if (updates.length === 0) {
            const row = await queryOne<ChatModerationRow>(
                'SELECT moderation_enabled, check_symbols, check_letters, max_message_length, max_letters_digits, timeout_minutes FROM chat_moderation_config WHERE id = 1'
            );
            const out = row
                ? {
                      moderationEnabled: row.moderation_enabled ?? true,
                      checkSymbols: row.check_symbols ?? true,
                      checkLetters: row.check_letters ?? true,
                      maxMessageLength: row.max_message_length,
                      maxLettersDigits: row.max_letters_digits ?? 300,
                      timeoutMinutes: row.timeout_minutes,
                  }
                : defaultModerationConfig();
            res.json(out);
            return;
        }

        await query(
            `UPDATE chat_moderation_config SET ${updates.join(', ')} WHERE id = 1`,
            params as number[]
        );

        const row = await queryOne<ChatModerationRow>(
            'SELECT moderation_enabled, check_symbols, check_letters, max_message_length, max_letters_digits, timeout_minutes FROM chat_moderation_config WHERE id = 1'
        );
        const config = row
            ? {
                  moderationEnabled: row.moderation_enabled ?? true,
                  checkSymbols: row.check_symbols ?? true,
                  checkLetters: row.check_letters ?? true,
                  maxMessageLength: row.max_message_length,
                  maxLettersDigits: row.max_letters_digits ?? 300,
                  timeoutMinutes: row.timeout_minutes,
              }
            : defaultModerationConfig();

        console.log(
            '[Модерация] Сохранено: Модерация чата=' +
                (config.moderationEnabled ? 'ВКЛ' : 'ВЫКЛ') +
                ', Проверка по символам=' +
                (config.checkSymbols ? 'ВКЛ' : 'ВЫКЛ') +
                ', Проверка по буквам и цифрам=' +
                (config.checkLetters ? 'ВКЛ' : 'ВЫКЛ')
        );
        if (onChatModerationConfigUpdatedCallback) onChatModerationConfigUpdatedCallback();
        res.json(config);
    } catch (error) {
        console.error('❌ Ошибка сохранения конфига модерации чата:', error);
        res.status(500).json({ error: 'Ошибка сохранения конфига модерации чата' });
    }
});

// Настройки дуэлей (таймаут, очки, штраф за промах)
type DuelConfigRow = { timeout_minutes: number; win_points: number; loss_points: number; miss_penalty: number };

app.get('/api/admin/duels/config', async (req: Request, res: Response) => {
    try {
        const row = await queryOne<DuelConfigRow>('SELECT timeout_minutes, win_points, loss_points, miss_penalty FROM duel_config WHERE id = 1');
        if (!row) {
            res.json({ timeoutMinutes: 5, winPoints: 25, lossPoints: 25, missPenalty: 5 });
            return;
        }
        res.json({
            timeoutMinutes: row.timeout_minutes,
            winPoints: row.win_points,
            lossPoints: row.loss_points,
            missPenalty: row.miss_penalty ?? 5,
        });
    } catch (error) {
        console.error('❌ Ошибка получения конфига дуэлей:', error);
        res.status(500).json({ error: 'Ошибка получения конфига' });
    }
});

app.post('/api/admin/duels/config', async (req: Request, res: Response) => {
    try {
        const timeoutMinutes = req.body?.timeoutMinutes != null ? Number(req.body.timeoutMinutes) : undefined;
        const winPoints = req.body?.winPoints != null ? Number(req.body.winPoints) : undefined;
        const lossPoints = req.body?.lossPoints != null ? Number(req.body.lossPoints) : undefined;
        const missPenalty = req.body?.missPenalty != null ? Number(req.body.missPenalty) : undefined;
        if (
            (timeoutMinutes != null && (Number.isNaN(timeoutMinutes) || timeoutMinutes < 0)) ||
            (winPoints != null && (Number.isNaN(winPoints) || winPoints < 0)) ||
            (lossPoints != null && (Number.isNaN(lossPoints) || lossPoints < 0)) ||
            (missPenalty != null && (Number.isNaN(missPenalty) || missPenalty < 0))
        ) {
            res.status(400).json({ error: 'Значения должны быть неотрицательными числами' });
            return;
        }
        const updates: string[] = [];
        const params: number[] = [];
        let i = 1;
        if (timeoutMinutes != null) {
            updates.push(`timeout_minutes = $${i++}`);
            params.push(timeoutMinutes);
        }
        if (winPoints != null) {
            updates.push(`win_points = $${i++}`);
            params.push(winPoints);
        }
        if (lossPoints != null) {
            updates.push(`loss_points = $${i++}`);
            params.push(lossPoints);
        }
        if (missPenalty != null) {
            updates.push(`miss_penalty = $${i++}`);
            params.push(missPenalty);
        }
        if (updates.length === 0) {
            const row = await queryOne<DuelConfigRow>('SELECT timeout_minutes, win_points, loss_points, miss_penalty FROM duel_config WHERE id = 1');
            const out = row
                ? { timeoutMinutes: row.timeout_minutes, winPoints: row.win_points, lossPoints: row.loss_points, missPenalty: row.miss_penalty ?? 5 }
                : { timeoutMinutes: 5, winPoints: 25, lossPoints: 25, missPenalty: 5 };
            res.json(out);
            return;
        }
        await query(
            `UPDATE duel_config SET ${updates.join(', ')} WHERE id = 1`,
            params
        );
        const row = await queryOne<DuelConfigRow>('SELECT timeout_minutes, win_points, loss_points, miss_penalty FROM duel_config WHERE id = 1');
        const config = row
            ? { timeoutMinutes: row.timeout_minutes, winPoints: row.win_points, lossPoints: row.loss_points, missPenalty: row.miss_penalty ?? 5 }
            : { timeoutMinutes: 5, winPoints: 25, lossPoints: 25, missPenalty: 5 };
        if (onDuelConfigUpdatedCallback) onDuelConfigUpdatedCallback(config);
        res.json(config);
    } catch (error) {
        console.error('❌ Ошибка сохранения конфига дуэлей:', error);
        res.status(500).json({ error: 'Ошибка сохранения конфига' });
    }
});

// Дейлики: ежедневная награда и серия побед
type DailyConfigRow = { daily_games_count: number; daily_reward_points: number; streak_wins_count: number; streak_reward_points: number };

app.get('/api/admin/duels/daily-config', async (req: Request, res: Response) => {
    try {
        const row = await queryOne<DailyConfigRow>('SELECT daily_games_count, daily_reward_points, streak_wins_count, streak_reward_points FROM duel_daily_config WHERE id = 1');
        if (!row) {
            res.json({ dailyGamesCount: 5, dailyRewardPoints: 50, streakWinsCount: 3, streakRewardPoints: 100 });
            return;
        }
        res.json({
            dailyGamesCount: row.daily_games_count,
            dailyRewardPoints: row.daily_reward_points,
            streakWinsCount: row.streak_wins_count,
            streakRewardPoints: row.streak_reward_points,
        });
    } catch (error) {
        console.error('❌ Ошибка получения конфига дейликов:', error);
        res.status(500).json({ error: 'Ошибка получения конфига' });
    }
});

app.post('/api/admin/duels/daily-config', async (req: Request, res: Response) => {
    try {
        const dailyGamesCount = req.body?.dailyGamesCount != null ? Number(req.body.dailyGamesCount) : undefined;
        const dailyRewardPoints = req.body?.dailyRewardPoints != null ? Number(req.body.dailyRewardPoints) : undefined;
        const streakWinsCount = req.body?.streakWinsCount != null ? Number(req.body.streakWinsCount) : undefined;
        const streakRewardPoints = req.body?.streakRewardPoints != null ? Number(req.body.streakRewardPoints) : undefined;
        if (
            (dailyGamesCount != null && (Number.isNaN(dailyGamesCount) || dailyGamesCount < 0)) ||
            (dailyRewardPoints != null && (Number.isNaN(dailyRewardPoints) || dailyRewardPoints < 0)) ||
            (streakWinsCount != null && (Number.isNaN(streakWinsCount) || streakWinsCount < 0)) ||
            (streakRewardPoints != null && (Number.isNaN(streakRewardPoints) || streakRewardPoints < 0))
        ) {
            res.status(400).json({ error: 'Значения должны быть неотрицательными числами' });
            return;
        }
        const updates: string[] = [];
        const params: number[] = [];
        let i = 1;
        if (dailyGamesCount != null) { updates.push(`daily_games_count = $${i++}`); params.push(dailyGamesCount); }
        if (dailyRewardPoints != null) { updates.push(`daily_reward_points = $${i++}`); params.push(dailyRewardPoints); }
        if (streakWinsCount != null) { updates.push(`streak_wins_count = $${i++}`); params.push(streakWinsCount); }
        if (streakRewardPoints != null) { updates.push(`streak_reward_points = $${i++}`); params.push(streakRewardPoints); }
        if (updates.length === 0) {
            const row = await queryOne<DailyConfigRow>('SELECT daily_games_count, daily_reward_points, streak_wins_count, streak_reward_points FROM duel_daily_config WHERE id = 1');
            const out = row
                ? { dailyGamesCount: row.daily_games_count, dailyRewardPoints: row.daily_reward_points, streakWinsCount: row.streak_wins_count, streakRewardPoints: row.streak_reward_points }
                : { dailyGamesCount: 5, dailyRewardPoints: 50, streakWinsCount: 3, streakRewardPoints: 100 };
            res.json(out);
            return;
        }
        await query(`UPDATE duel_daily_config SET ${updates.join(', ')} WHERE id = 1`, params);
        const row = await queryOne<DailyConfigRow>('SELECT daily_games_count, daily_reward_points, streak_wins_count, streak_reward_points FROM duel_daily_config WHERE id = 1');
        const config = row
            ? { dailyGamesCount: row.daily_games_count, dailyRewardPoints: row.daily_reward_points, streakWinsCount: row.streak_wins_count, streakRewardPoints: row.streak_reward_points }
            : { dailyGamesCount: 5, dailyRewardPoints: 50, streakWinsCount: 3, streakRewardPoints: 100 };
        if (onDuelDailyConfigUpdatedCallback) onDuelDailyConfigUpdatedCallback(config);
        res.json(config);
    } catch (error) {
        console.error('❌ Ошибка сохранения конфига дейликов:', error);
        res.status(500).json({ error: 'Ошибка сохранения конфига' });
    }
});

// Признак режима разработки (кнопки сброса только в dev)
const isDevMode = process.env.NODE_ENV !== 'production';
app.get('/api/admin/dev-mode', (_req: Request, res: Response) => {
    res.json({ devMode: isDevMode });
});

// Сброс флагов и счётчиков наград дейлика и серии (для теста) — только в dev
app.post('/api/admin/duels/reset-reward-flags', async (req: Request, res: Response) => {
    if (!isDevMode) {
        res.status(403).json({ error: 'Доступно только в режиме разработки' });
        return;
    }
    try {
        await query(`
            UPDATE twitch_player_stats
            SET last_daily_quest_reward_date = NULL,
                streak_reward_active = false,
                duels_today = 0,
                duel_win_streak = 0
        `);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка сброса флагов наград:', error);
        res.status(500).json({ error: 'Ошибка сброса флагов' });
    }
});

// Сброс очков у всех игроков — по 1000 (для теста), только в dev
app.post('/api/admin/duels/reset-points', async (req: Request, res: Response) => {
    if (!isDevMode) {
        res.status(403).json({ error: 'Доступно только в режиме разработки' });
        return;
    }
    try {
        await query(`UPDATE twitch_player_stats SET points = 1000`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка сброса очков:', error);
        res.status(500).json({ error: 'Ошибка сброса очков' });
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

// Список игроков с таймаутом дуэли
app.get('/api/admin/duels/banned', async (req: Request, res: Response) => {
    try {
        const list = await getDuelBannedList();
        res.json({ list });
    } catch (error) {
        console.error('❌ Ошибка получения списка забаненных:', error);
        res.status(500).json({ error: 'Ошибка получения списка' });
    }
});

// Амнистия для одного игрока
app.post('/api/admin/duels/pardon/:username', async (req: Request, res: Response) => {
    const username = req.params.username;
    if (!username) {
        res.status(400).json({ error: 'Не указан пользователь' });
        return;
    }
    try {
        await executePardonDuelUser(decodeURIComponent(username));
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка амнистии для пользователя:', error);
        res.status(500).json({ error: 'Ошибка амнистии' });
    }
});

// === Публичные страницы ===

// Главная страница - редирект на /public
app.get('/', (req: Request, res: Response) => {
    res.redirect('/public');
});

// SPA — все маршруты отдают index.html (роутинг на клиенте)
// В dev папки public нет (UI собирает Vite) — показываем подсказку вместо ENOENT
app.get(['/public', '/public/duel', '/public/links', '/admin'], (req: Request, res: Response) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else if (process.env.NODE_ENV !== 'production') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Dev</title></head><body style="font-family:sans-serif;padding:2rem;">' +
            '<p>В режиме разработки интерфейс отдаёт Vite.</p>' +
            '<p>Запустите <code>npm run dev:all</code> и откройте <a href="http://localhost:5173/public">http://localhost:5173/public</a> или <a href="http://localhost:5173/admin">http://localhost:5173/admin</a>.</p>' +
            '</body></html>'
        );
    } else {
        res.status(404).send('Not found');
    }
});

// Колбэки для связи с Twitch-сервисом
let onCommandsChangedCallback: (() => void) | null = null;
let onCommandExecuteCallback: ((id: string) => void | Promise<void>) | null = null;
let onLinksSendCallback: (() => void | Promise<void>) | null = null;
let onEnableDuelsCallback: (() => void | Promise<void>) | null = null;
let onDisableDuelsCallback: (() => void | Promise<void>) | null = null;
let onPardonAllCallback: (() => void | Promise<void>) | null = null;
let getDuelBannedListCallback: (() => Promise<{ username: string; timeoutUntil: number }[]>) | null = null;
let pardonDuelUserCallback: ((username: string) => Promise<void>) | null = null;
let getDuelsStatusCallback: (() => boolean) | null = null;
let getDuelCooldownSkipCallback: (() => boolean) | null = null;
let setDuelCooldownSkipCallback: ((skip: boolean) => void) | null = null;
let onDuelConfigUpdatedCallback: ((config: { timeoutMinutes: number; winPoints: number; lossPoints: number; missPenalty: number }) => void) | null = null;
let onDuelDailyConfigUpdatedCallback: ((config: { dailyGamesCount: number; dailyRewardPoints: number; streakWinsCount: number; streakRewardPoints: number }) => void) | null = null;
let onLinksConfigUpdatedCallback: ((config: LinksConfig) => void) | null = null;
let onChatModerationConfigUpdatedCallback: (() => void) | null = null;

export function setOnCommandsChangedCallback(callback: () => void) {
    onCommandsChangedCallback = callback;
}

export function setOnCommandExecuteCallback(callback: (id: string) => void | Promise<void>) {
    onCommandExecuteCallback = callback;
}

export function setOnLinksSendCallback(callback: () => void | Promise<void>) {
    onLinksSendCallback = callback;
}

export function setOnLinksConfigUpdatedCallback(callback: (config: LinksConfig) => void) {
    onLinksConfigUpdatedCallback = callback;
}

export function setOnChatModerationConfigUpdatedCallback(callback: () => void) {
    onChatModerationConfigUpdatedCallback = callback;
}

export function setOnPartyConfigUpdatedCallback(callback: () => void) {
    onPartyConfigUpdatedCallback = callback;
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

export function setGetDuelBannedListCallback(callback: () => Promise<{ username: string; timeoutUntil: number }[]>) {
    getDuelBannedListCallback = callback;
}

export function setPardonDuelUserCallback(callback: (username: string) => Promise<void>) {
    pardonDuelUserCallback = callback;
}

export function setGetDuelsStatusCallback(callback: () => boolean) {
    getDuelsStatusCallback = callback;
}

export function setGetDuelCooldownSkipCallback(callback: () => boolean) {
    getDuelCooldownSkipCallback = callback;
}

export function setSetDuelCooldownSkipCallback(callback: (skip: boolean) => void) {
    setDuelCooldownSkipCallback = callback;
}

export function setOnDuelConfigUpdatedCallback(callback: (config: { timeoutMinutes: number; winPoints: number; lossPoints: number; missPenalty: number }) => void) {
    onDuelConfigUpdatedCallback = callback;
}

export function setOnDuelDailyConfigUpdatedCallback(callback: (config: { dailyGamesCount: number; dailyRewardPoints: number; streakWinsCount: number; streakRewardPoints: number }) => void) {
    onDuelDailyConfigUpdatedCallback = callback;
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

async function getDuelBannedList(): Promise<{ username: string; timeoutUntil: number }[]> {
    if (!getDuelBannedListCallback) {
        return [];
    }
    return getDuelBannedListCallback();
}

async function executePardonDuelUser(username: string): Promise<void> {
    if (!pardonDuelUserCallback) {
        throw new Error('pardonDuelUserCallback is not set');
    }
    await pardonDuelUserCallback(username);
}

function getDuelsStatus(): boolean {
    if (!getDuelsStatusCallback) {
        return false;
    }
    return getDuelsStatusCallback();
}

/**
 * Вызвать при изменении списка забаненных по дуэлям (добавление/снятие).
 * Подписчики (админка) обновят таблицу.
 */
export function getBroadcastDuelBannedChanged(): (() => void) | null {
    return broadcastDuelBannedChanged;
}

// Запуск сервера (HTTP + WebSocket на том же порту)
export function startWebServer(): Promise<void> {
    return new Promise((resolve) => {
        const server = http.createServer(app);

        wss = new WebSocket.Server({ server, path: WS_PATH });
        const clients = new Set<WebSocket>();

        wss.on('connection', (ws: WebSocket) => {
            clients.add(ws);
            ws.on('close', () => { clients.delete(ws); });
            ws.on('error', () => { clients.delete(ws); });
        });

        const payload = JSON.stringify({ type: 'duel-banned-changed' });
        broadcastDuelBannedChanged = () => {
            clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(payload);
                }
            });
        };

        server.listen(PORT, () => {
            console.log(`🌐 Веб-интерфейс доступен: http://localhost:${PORT}`);
            console.log(`🔌 WebSocket для админки: ws://localhost:${PORT}${WS_PATH}`);
            resolve();
        });
    });
}

// Если запускается напрямую
if (require.main === module) {
    startWebServer().catch(console.error);
}
