import { queryDonateX, getDonateXPool } from '../../database/donatex-database';
import {
  getDonateXTopByDayMatrixSince,
  type DonateXDayTopMatrixRow,
} from './donatex-storage';
import { isDonateXExcludedFromTop } from './donatex-username';

const CONFIG_ID = 'default';

/** С какой даты считаем накопительные очки (включительно, МСК). */
export const DONATEX_CUMULATIVE_POINTS_SINCE =
  process.env.DONATEX_POINTS_SINCE?.trim() || '2026-04-06';

export interface DonateXDayTopPointsConfig {
  pointsTop1: number;
  pointsTop2: number;
  pointsTop3: number;
  updatedAt: string | null;
}

export interface DonateXMonthlyPointsEntry {
  username: string;
  totalPoints: number;
  asTop1: number;
  asTop2: number;
  asTop3: number;
}

const DEFAULT_POINTS: DonateXDayTopPointsConfig = {
  pointsTop1: 3,
  pointsTop2: 2,
  pointsTop3: 1,
  updatedAt: null,
};

export async function ensureDonateXDayTopPointsTable(): Promise<void> {
  if (!getDonateXPool()) return;
  await queryDonateX(`
    CREATE TABLE IF NOT EXISTS donatex_daytop_points_config (
      id TEXT PRIMARY KEY,
      points_top1 INTEGER NOT NULL DEFAULT 3,
      points_top2 INTEGER NOT NULL DEFAULT 2,
      points_top3 INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await queryDonateX(
    `INSERT INTO donatex_daytop_points_config (id, points_top1, points_top2, points_top3)
     VALUES ($1, 3, 2, 1)
     ON CONFLICT (id) DO NOTHING`,
    [CONFIG_ID]
  );
}

export async function getDonateXDayTopPointsConfig(): Promise<DonateXDayTopPointsConfig> {
  await ensureDonateXDayTopPointsTable();
  const [row] = await queryDonateX<{
    points_top1: number;
    points_top2: number;
    points_top3: number;
    updated_at: string | null;
  }>(
    `SELECT points_top1, points_top2, points_top3, updated_at::text
     FROM donatex_daytop_points_config WHERE id = $1`,
    [CONFIG_ID]
  );
  if (!row) return { ...DEFAULT_POINTS };
  return {
    pointsTop1: row.points_top1,
    pointsTop2: row.points_top2,
    pointsTop3: row.points_top3,
    updatedAt: row.updated_at,
  };
}

export async function saveDonateXDayTopPointsConfig(config: {
  pointsTop1: number;
  pointsTop2: number;
  pointsTop3: number;
}): Promise<DonateXDayTopPointsConfig> {
  await ensureDonateXDayTopPointsTable();
  const p1 = Math.min(9999, Math.max(0, Math.round(config.pointsTop1)));
  const p2 = Math.min(9999, Math.max(0, Math.round(config.pointsTop2)));
  const p3 = Math.min(9999, Math.max(0, Math.round(config.pointsTop3)));
  const [row] = await queryDonateX<{
    points_top1: number;
    points_top2: number;
    points_top3: number;
    updated_at: string;
  }>(
    `INSERT INTO donatex_daytop_points_config (id, points_top1, points_top2, points_top3, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET
       points_top1 = EXCLUDED.points_top1,
       points_top2 = EXCLUDED.points_top2,
       points_top3 = EXCLUDED.points_top3,
       updated_at = NOW()
     RETURNING points_top1, points_top2, points_top3, updated_at::text`,
    [CONFIG_ID, p1, p2, p3]
  );
  return {
    pointsTop1: row.points_top1,
    pointsTop2: row.points_top2,
    pointsTop3: row.points_top3,
    updatedAt: row.updated_at,
  };
}

/** Сумма очков за месяц: каждый день топ-1/2/3 даёт баллы из настроек. */
export function computeDonateXMonthlyPointsLeaderboard(
  rows: DonateXDayTopMatrixRow[],
  config: Pick<DonateXDayTopPointsConfig, 'pointsTop1' | 'pointsTop2' | 'pointsTop3'>
): DonateXMonthlyPointsEntry[] {
  const map = new Map<
    string,
    { totalPoints: number; asTop1: number; asTop2: number; asTop3: number }
  >();

  const add = (username: string | null, slot: 1 | 2 | 3) => {
    if (isDonateXExcludedFromTop(username)) return;
    const name = username!.trim();
    const cur = map.get(name) ?? { totalPoints: 0, asTop1: 0, asTop2: 0, asTop3: 0 };
    if (slot === 1) {
      cur.totalPoints += config.pointsTop1;
      cur.asTop1 += 1;
    } else if (slot === 2) {
      cur.totalPoints += config.pointsTop2;
      cur.asTop2 += 1;
    } else {
      cur.totalPoints += config.pointsTop3;
      cur.asTop3 += 1;
    }
    map.set(name, cur);
  };

  for (const row of rows) {
    // Очки только за топ внутри сессии стрима (stream_start), не за «голый» календарный день
    if (!row.stream_start) continue;
    add(row.top1_username, 1);
    add(row.top2_username, 2);
    add(row.top3_username, 3);
  }

  return [...map.entries()]
    .map(([username, stats]) => ({
      username,
      totalPoints: stats.totalPoints,
      asTop1: stats.asTop1,
      asTop2: stats.asTop2,
      asTop3: stats.asTop3,
    }))
    .sort((a, b) => b.totalPoints - a.totalPoints || a.username.localeCompare(b.username, 'ru'));
}

/** Накопительный рейтинг очков с DONATEX_CUMULATIVE_POINTS_SINCE (текущие баллы за места). */
export async function getDonateXCumulativePointsLeaderboard(hideTest?: boolean): Promise<{
  since: string;
  leaderboard: DonateXMonthlyPointsEntry[];
}> {
  const config = await getDonateXDayTopPointsConfig();
  const rows = await getDonateXTopByDayMatrixSince(DONATEX_CUMULATIVE_POINTS_SINCE, hideTest);
  return {
    since: DONATEX_CUMULATIVE_POINTS_SINCE,
    leaderboard: computeDonateXMonthlyPointsLeaderboard(rows, config),
  };
}
