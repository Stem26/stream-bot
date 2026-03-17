import { query } from '../database/database';

export type JournalEventType = 'message' | 'command' | 'system';

interface JournalEntry {
  id: number;
  createdAt: string;
  username: string;
  message: string;
  eventType: JournalEventType;
}

const MAX_MESSAGE_LENGTH = 2000;

/**
 * Записывает событие в журнал (БД).
 * Вызывается асинхронно — не блокирует основной поток.
 */
export function logJournalEvent(
  username: string,
  message: string,
  eventType: JournalEventType = 'message',
): void {
  const safeUsername = String(username ?? '').slice(0, 255).trim();
  const safeMessage = String(message ?? '').slice(0, MAX_MESSAGE_LENGTH).trim();
  if (!safeMessage && eventType === 'message') return;

  void query(
    `INSERT INTO event_journal (username, message, event_type) VALUES ($1, $2, $3)`,
    [safeUsername || 'system', safeMessage || '(пусто)', eventType],
  ).catch((err) => {
    console.error('❌ Ошибка записи в журнал:', err?.message || err);
  });
}

/**
 * Удаляет записи старше N дней (для экономии места).
 */
export async function pruneOldJournalEntries(keepDays: number = 7): Promise<number> {
  try {
    const result = await query<{ deleted: number }>(
      `WITH deleted AS (
         DELETE FROM event_journal
         WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
         RETURNING id
       )
       SELECT COUNT(*)::int AS deleted FROM deleted`,
      [keepDays],
    );
    const count = result[0]?.deleted ?? 0;
    if (count > 0) {
      console.log(`🗑️ Удалено ${count} старых записей из журнала (старше ${keepDays} дней)`);
    }
    return count;
  } catch (err) {
    console.error('❌ Ошибка очистки журнала:', err);
    return 0;
  }
}

export type { JournalEntry };
