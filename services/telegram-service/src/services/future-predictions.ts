import { query } from '../database/database';
import { predictions as fallbackPredictions } from '../utils/predictions';

export async function getActiveFuturePredictions(): Promise<string[]> {
  try {
    const rows = await query<{ text: string }>(
      `SELECT text
       FROM telegram_future_predictions
       WHERE enabled = TRUE AND BTRIM(text) <> ''
       ORDER BY sort_order ASC, id ASC`
    );
    const predictions = rows.map((row) => row.text.trim()).filter(Boolean);
    if (predictions.length > 0) {
      return predictions;
    }
  } catch (error) {
    console.warn('⚠️ Не удалось загрузить предсказания из БД, используем fallback:', error);
  }

  return fallbackPredictions;
}
