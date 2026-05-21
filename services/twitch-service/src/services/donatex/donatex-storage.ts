import { queryDonateX, getDonateXPool } from '../../database/donatex-database';
import {
  findStreamWindowsForDate,
  loadDonateXStreamWindowsForMonth,
  streamWindowsToJsonb,
} from './donatex-stream-windows';
import { parseDonateXTimestamp } from './donatex-normalize';
import { donatexTopUsernameSql } from './donatex-username';
import { DonateXDonation, DonateXDonationSource } from './types';

export interface DonateXSaveResult {
  inserted: boolean;
  donationId: string;
}

/** Сохраняет донат; при новой записи обновляет агрегаты донатера. */
export async function saveDonateXDonation(
  donation: DonateXDonation,
  source: DonateXDonationSource,
  rawPayload?: Record<string, unknown>
): Promise<DonateXSaveResult> {
  if (!getDonateXPool()) {
    return { inserted: false, donationId: donation.id };
  }

  const donatedAt = parseDonateXTimestamp(donation.timestamp);
  if (Number.isNaN(donatedAt.getTime())) {
    throw new Error(`[DONATEX] Некорректный timestamp: ${donation.timestamp}`);
  }

  const username = donation.username;
  const rows = await queryDonateX<{ id: string; inserted: boolean }>(
    `INSERT INTO donatex_donations (
      id, username, message, currency, amount, amount_in_rub, donated_at,
      with_ai_response, ai_response, is_test,
      source, raw_payload, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10,
      $11, $12::jsonb, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      username = EXCLUDED.username,
      message = EXCLUDED.message,
      amount = EXCLUDED.amount,
      amount_in_rub = EXCLUDED.amount_in_rub,
      donated_at = EXCLUDED.donated_at,
      raw_payload = COALESCE(EXCLUDED.raw_payload, donatex_donations.raw_payload),
      updated_at = NOW()
    RETURNING id, (xmax = 0) AS inserted`,
    [
      donation.id,
      username,
      donation.message ?? '',
      donation.currency,
      donation.amount,
      donation.amountInRub,
      donatedAt.toISOString(),
      donation.withAiResponse ?? false,
      donation.aiResponse ?? null,
      donation.isTest ?? false,
      source,
      rawPayload ? JSON.stringify(rawPayload) : null,
    ]
  );

  const row = rows[0];
  const inserted = Boolean(row?.inserted);

  if (inserted) {
    await upsertDonateXDonor(donation, username, donatedAt);
  }

  return { inserted, donationId: donation.id };
}

async function upsertDonateXDonor(
  donation: DonateXDonation,
  username: string,
  donatedAt: Date
): Promise<void> {
  const currencyKey = donation.currency.toUpperCase();

  await queryDonateX(
    `INSERT INTO donatex_donors (
      username, donation_count, total_amount_rub, total_by_currency,
      first_donation_at, last_donation_at, last_message, last_currency, last_amount,
      test_donation_count, updated_at
    ) VALUES (
      $1, 1, $2, jsonb_build_object($3::text, $4::numeric),
      $5, $5, $6, $7, $8,
      $9, NOW()
    )
    ON CONFLICT (username) DO UPDATE SET
      donation_count = donatex_donors.donation_count + 1,
      total_amount_rub = donatex_donors.total_amount_rub + EXCLUDED.total_amount_rub,
      total_by_currency = jsonb_set(
        COALESCE(donatex_donors.total_by_currency, '{}'::jsonb),
        ARRAY[$3::text],
        to_jsonb(
          COALESCE((donatex_donors.total_by_currency ->> $3::text)::numeric, 0) + $4::numeric
        )
      ),
      first_donation_at = LEAST(donatex_donors.first_donation_at, EXCLUDED.first_donation_at),
      last_donation_at = GREATEST(donatex_donors.last_donation_at, EXCLUDED.last_donation_at),
      last_message = EXCLUDED.last_message,
      last_currency = EXCLUDED.last_currency,
      last_amount = EXCLUDED.last_amount,
      test_donation_count = donatex_donors.test_donation_count + EXCLUDED.test_donation_count,
      updated_at = NOW()`,
    [
      username,
      donation.amountInRub,
      currencyKey,
      donation.amount,
      donatedAt.toISOString(),
      donation.message ?? '',
      donation.currency,
      donation.amount,
      donation.isTest ? 1 : 0,
    ]
  );
}

/** Удаляет старые локальные тестовые записи (id test-local-*). */
export async function purgeDonateXLocalSeedDonations(): Promise<void> {
  if (!getDonateXPool()) {
    return;
  }
  const deleted = await queryDonateX<{ id: string }>(
    `DELETE FROM donatex_donations WHERE id LIKE 'test-local-%' RETURNING id`
  );
  if (deleted.length > 0) {
    await rebuildDonateXDonorStats();
    console.log(`[DONATEX] Удалено тестовых донатов: ${deleted.length}`);
  }
}

/** Пересчёт агрегатов из donatex_donations (после массового backfill). */
export async function rebuildDonateXDonorStats(): Promise<void> {
  if (!getDonateXPool()) {
    return;
  }

  await queryDonateX(`DELETE FROM donatex_donors`);

  await queryDonateX(`
    INSERT INTO donatex_donors (
      username, donation_count, total_amount_rub, total_by_currency,
      first_donation_at, last_donation_at, last_message, last_currency, last_amount,
      test_donation_count, updated_at
    )
    SELECT
      username,
      COUNT(*)::int,
      COALESCE(SUM(amount_in_rub), 0),
      COALESCE(
        (SELECT jsonb_object_agg(currency, total)
         FROM (
           SELECT currency, SUM(amount) AS total
           FROM donatex_donations d2
           WHERE d2.username = d.username
           GROUP BY currency
         ) t),
        '{}'::jsonb
      ),
      MIN(donated_at),
      MAX(donated_at),
      (ARRAY_AGG(message ORDER BY donated_at DESC))[1],
      (ARRAY_AGG(currency ORDER BY donated_at DESC))[1],
      (ARRAY_AGG(amount ORDER BY donated_at DESC))[1],
      COUNT(*) FILTER (WHERE is_test)::int,
      NOW()
    FROM donatex_donations d
    GROUP BY username
  `);

  console.log('✅ [DONATEX] Агрегаты donatex_donors пересчитаны');
}

function extractTimestampFromRawPayload(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ts = String(o.timestamp ?? o.donated_at ?? '').trim();
  return ts || null;
}

/** Исправляет donated_at по raw_payload (МСК без offset → UTC). */
export async function repairDonateXDonationTimestamps(): Promise<number> {
  if (!getDonateXPool()) {
    return 0;
  }

  const rows = await queryDonateX<{
    id: string;
    donated_at: string;
    raw_payload: Record<string, unknown> | null;
  }>(
    `SELECT id, donated_at::text AS donated_at, raw_payload
     FROM donatex_donations
     WHERE raw_payload IS NOT NULL`
  );

  let fixed = 0;
  for (const row of rows) {
    const ts = extractTimestampFromRawPayload(row.raw_payload);
    if (!ts) continue;

    const corrected = parseDonateXTimestamp(ts);
    if (Number.isNaN(corrected.getTime())) continue;

    const current = new Date(row.donated_at);
    if (Math.abs(corrected.getTime() - current.getTime()) < 60_000) {
      continue;
    }

    await queryDonateX(`UPDATE donatex_donations SET donated_at = $1 WHERE id = $2`, [
      corrected.toISOString(),
      row.id,
    ]);
    fixed++;
  }

  if (fixed > 0) {
    await rebuildDonateXDonorStats();
    console.log(`✅ [DONATEX] Исправлено donated_at: ${fixed}`);
  }

  return fixed;
}

const DONATEX_TZ = process.env.DONATEX_STATS_TZ?.trim() || 'Europe/Moscow';

export interface DonateXDonorRankRow {
  username: string;
  donation_count: number;
  total_amount_rub: string;
  last_donation_at: string;
}

/**
 * Топ донатеров за календарный день (по умолчанию — сегодня, Europe/Moscow).
 * date: YYYY-MM-DD или пусто = сегодня в DONATEX_TZ.
 */
export async function getTopDonateXDonorsForDay(options?: {
  date?: string;
  limit?: number;
  hideTest?: boolean;
}): Promise<{ date: string; timezone: string; donors: DonateXDonorRankRow[] }> {
  const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
  const hideTest = options?.hideTest !== false;
  const date = options?.date?.trim() || null;

  const rows = await queryDonateX<DonateXDonorRankRow>(
    `SELECT
      username,
      COUNT(*)::int AS donation_count,
      COALESCE(SUM(amount_in_rub), 0)::text AS total_amount_rub,
      MAX(donated_at)::text AS last_donation_at
    FROM donatex_donations
    WHERE donated_at >= (
      COALESCE($1::date, (NOW() AT TIME ZONE $3)::date)
      AT TIME ZONE $3
    )
      AND donated_at < (
      (COALESCE($1::date, (NOW() AT TIME ZONE $3)::date) + INTERVAL '1 day')
      AT TIME ZONE $3
    )
      AND ($2::boolean = FALSE OR is_test = FALSE)
    GROUP BY username
    ORDER BY SUM(amount_in_rub) DESC, MAX(donated_at) DESC, COUNT(*) DESC
    LIMIT $4`,
    [date, hideTest, DONATEX_TZ, limit]
  );

  const effectiveDate =
    date ??
    (await queryDonateX<{ d: string }>(
      `SELECT (NOW() AT TIME ZONE $1)::date::text AS d`,
      [DONATEX_TZ]
    ))[0]?.d ??
    '';

  return { date: effectiveDate, timezone: DONATEX_TZ, donors: rows };
}

export interface DonateXDayDonorBreakdownRow {
  username: string;
  donation_count: number;
  total_amount_rub: string;
  first_donation_at: string;
  last_donation_at: string;
}

/** Полный рейтинг донатеров за один день (для сверки с табличкой / DonateX). */
export async function getDonateXDayDonorBreakdown(options: {
  date: string;
  limit?: number;
  hideTest?: boolean;
}): Promise<{
  date: string;
  timezone: string;
  groupBy: 'stream' | 'calendar';
  donors: DonateXDayDonorBreakdownRow[];
}> {
  const date = options.date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('date должен быть YYYY-MM-DD');
  }
  const limit = Math.min(200, Math.max(1, options?.limit ?? 50));
  const hideTest = options?.hideTest !== false;

  const [y, m] = date.split('-').map((x) => parseInt(x, 10));
  const windows =
    y && m ? await loadDonateXStreamWindowsForMonth(y, m, DONATEX_TZ) : [];
  const streamsOnDate = findStreamWindowsForDate(windows, date);

  const donors = streamsOnDate.length > 0
    ? await queryDonateX<DonateXDayDonorBreakdownRow>(
        `SELECT
          username,
          COUNT(*)::int AS donation_count,
          COALESCE(SUM(amount_in_rub), 0)::text AS total_amount_rub,
          MIN(donated_at)::text AS first_donation_at,
          MAX(donated_at)::text AS last_donation_at
        FROM donatex_donations
        WHERE ($1::boolean = FALSE OR is_test = FALSE)
          AND EXISTS (
            SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS w(
              stream_start timestamptz,
              stream_end timestamptz
            )
            WHERE donated_at >= w.stream_start AND donated_at < w.stream_end
          )
        GROUP BY username
        ORDER BY SUM(amount_in_rub) DESC, MAX(donated_at) DESC, COUNT(*) DESC
        LIMIT $3`,
        [
          hideTest,
          JSON.stringify(
            streamsOnDate.map((w) => ({
              stream_start: w.streamStart,
              stream_end: w.streamEnd,
            }))
          ),
          limit,
        ]
      )
    : await queryDonateX<DonateXDayDonorBreakdownRow>(
        `SELECT
          username,
          COUNT(*)::int AS donation_count,
          COALESCE(SUM(amount_in_rub), 0)::text AS total_amount_rub,
          MIN(donated_at)::text AS first_donation_at,
          MAX(donated_at)::text AS last_donation_at
        FROM donatex_donations
        WHERE donated_at >= ($1::date AT TIME ZONE $2)
          AND donated_at < (($1::date + INTERVAL '1 day') AT TIME ZONE $2)
          AND ($3::boolean = FALSE OR is_test = FALSE)
        GROUP BY username
        ORDER BY SUM(amount_in_rub) DESC, MAX(donated_at) DESC, COUNT(*) DESC
        LIMIT $4`,
        [date, DONATEX_TZ, hideTest, limit]
      );

  return {
    date,
    timezone: DONATEX_TZ,
    groupBy: streamsOnDate.length > 0 ? 'stream' : 'calendar',
    donors,
  };
}

export interface DonateXDayTopMatrixRow {
  stream_date: string;
  stream_start: string | null;
  top1_username: string | null;
  top1_amount_rub: string | null;
  top2_username: string | null;
  top2_amount_rub: string | null;
  top3_username: string | null;
  top3_amount_rub: string | null;
}

function resolveTopByDayYearMonth(options?: {
  year?: number;
  month?: number;
}): { year: number; month: number } {
  const year = options?.year;
  const month = options?.month;
  if (
    year != null &&
    month != null &&
    year >= 2000 &&
    year <= 2100 &&
    month >= 1 &&
    month <= 12
  ) {
    return { year, month };
  }
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DONATEX_TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const y = parseInt(parts.find((p) => p.type === 'year')?.value ?? '2026', 10);
  const m = parseInt(parts.find((p) => p.type === 'month')?.value ?? '1', 10);
  return { year: y, month: m };
}

/** Топ-3 по сумме за сессию стрима (stream_history). Без стрима — строки нет. Календарный день только если истории за месяц нет. */
export async function getDonateXTopByDayMatrix(options?: {
  year?: number;
  month?: number;
  hideTest?: boolean;
}): Promise<{
  timezone: string;
  year: number;
  month: number;
  groupBy: 'stream' | 'calendar';
  rows: DonateXDayTopMatrixRow[];
}> {
  const hideTest = options?.hideTest !== false;
  const { year, month } = resolveTopByDayYearMonth(options);
  const windows = await loadDonateXStreamWindowsForMonth(year, month, DONATEX_TZ);
  const groupBy = windows.length > 0 ? 'stream' : 'calendar';

  const rows =
    windows.length > 0
      ? await queryDonateXTopByDayWithStreamWindows(year, month, hideTest, windows)
      : await queryDonateXTopByDayCalendar(year, month, hideTest);

  return { timezone: DONATEX_TZ, year, month, groupBy, rows };
}

/** Топ-3 по дням с sinceDate (включительно) по всем месяцам до текущего (МСК). */
export async function getDonateXTopByDayMatrixSince(
  sinceDate: string,
  hideTest?: boolean
): Promise<DonateXDayTopMatrixRow[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) {
    throw new Error('sinceDate должен быть YYYY-MM-DD');
  }
  const hide = hideTest !== false;
  const [startYear, startMonth] = sinceDate.split('-').map((x) => parseInt(x, 10));
  const { year: endYear, month: endMonth } = resolveTopByDayYearMonth();
  const all: DonateXDayTopMatrixRow[] = [];

  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const { rows } = await getDonateXTopByDayMatrix({ year, month, hideTest: hide });
    for (const row of rows) {
      if (dayTopRowMatchesSince(row, sinceDate)) {
        all.push(row);
      }
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return all;
}

function dayTopRowMatchesSince(row: DonateXDayTopMatrixRow, sinceDate: string): boolean {
  if (row.stream_start) {
    return row.stream_start.slice(0, 10) >= sinceDate;
  }
  return row.stream_date >= sinceDate;
}

async function queryDonateXTopByDayCalendar(
  year: number,
  month: number,
  hideTest: boolean
): Promise<DonateXDayTopMatrixRow[]> {
  return queryDonateX<DonateXDayTopMatrixRow>(
    `WITH daily AS (
      SELECT
        (donated_at AT TIME ZONE $1)::date AS stream_date,
        username,
        SUM(amount_in_rub) AS total_rub,
        COUNT(*)::int AS donation_count,
        MAX(donated_at) AS last_donation_at
      FROM donatex_donations
      WHERE donated_at >= (make_date($2::int, $3::int, 1) AT TIME ZONE $1)
        AND donated_at < ((make_date($2::int, $3::int, 1) + INTERVAL '1 month') AT TIME ZONE $1)
        AND ($4::boolean = FALSE OR is_test = FALSE)
        AND ${donatexTopUsernameSql('username')}
      GROUP BY (donated_at AT TIME ZONE $1)::date, username
    ),
    ranked AS (
      SELECT
        stream_date,
        username,
        total_rub,
        ROW_NUMBER() OVER (
          PARTITION BY stream_date
          ORDER BY total_rub DESC, last_donation_at DESC, username ASC
        ) AS rn
      FROM daily
    )
    SELECT
      stream_date::text AS stream_date,
      NULL::text AS stream_start,
      MAX(username) FILTER (WHERE rn = 1) AS top1_username,
      (MAX(total_rub) FILTER (WHERE rn = 1))::text AS top1_amount_rub,
      MAX(username) FILTER (WHERE rn = 2) AS top2_username,
      (MAX(total_rub) FILTER (WHERE rn = 2))::text AS top2_amount_rub,
      MAX(username) FILTER (WHERE rn = 3) AS top3_username,
      (MAX(total_rub) FILTER (WHERE rn = 3))::text AS top3_amount_rub
    FROM ranked
    WHERE rn <= 3
    GROUP BY stream_date
    ORDER BY stream_date DESC`,
    [DONATEX_TZ, year, month, hideTest]
  );
}

async function queryDonateXTopByDayWithStreamWindows(
  year: number,
  month: number,
  hideTest: boolean,
  windows: Awaited<ReturnType<typeof loadDonateXStreamWindowsForMonth>>
): Promise<DonateXDayTopMatrixRow[]> {
  return queryDonateX<DonateXDayTopMatrixRow>(
    `WITH windows AS (
      SELECT
        w.stream_date,
        w.stream_start::timestamptz AS stream_start,
        w.stream_end::timestamptz AS stream_end
      FROM jsonb_to_recordset($5::jsonb) AS w(
        stream_date text,
        stream_start timestamptz,
        stream_end timestamptz
      )
    ),
    stream_daily AS (
      SELECT
        s.stream_start,
        MIN(s.stream_date) AS stream_date,
        d.username,
        SUM(d.amount_in_rub) AS total_rub,
        COUNT(*)::int AS donation_count,
        MAX(d.donated_at) AS last_donation_at
      FROM donatex_donations d
      JOIN LATERAL (
        SELECT w.stream_date, w.stream_start, w.stream_end
        FROM windows w
        WHERE d.donated_at >= w.stream_start AND d.donated_at < w.stream_end
        ORDER BY w.stream_start DESC
        LIMIT 1
      ) s ON TRUE
      WHERE d.donated_at >= (make_date($1::int, $2::int, 1) AT TIME ZONE $3)
        AND d.donated_at < ((make_date($1::int, $2::int, 1) + INTERVAL '1 month') AT TIME ZONE $3)
        AND ($4::boolean = FALSE OR d.is_test = FALSE)
        AND ${donatexTopUsernameSql('d.username')}
      GROUP BY s.stream_start, d.username
    ),
    daily AS (
      SELECT * FROM stream_daily
    ),
    ranked AS (
      SELECT
        stream_start,
        stream_date,
        username,
        total_rub,
        stream_start::text AS session_key,
        ROW_NUMBER() OVER (
          PARTITION BY stream_start
          ORDER BY total_rub DESC, last_donation_at DESC, username ASC
        ) AS rn
      FROM daily
    )
    SELECT
      MIN(stream_date)::text AS stream_date,
      stream_start::text AS stream_start,
      MAX(username) FILTER (WHERE rn = 1) AS top1_username,
      (MAX(total_rub) FILTER (WHERE rn = 1))::text AS top1_amount_rub,
      MAX(username) FILTER (WHERE rn = 2) AS top2_username,
      (MAX(total_rub) FILTER (WHERE rn = 2))::text AS top2_amount_rub,
      MAX(username) FILTER (WHERE rn = 3) AS top3_username,
      (MAX(total_rub) FILTER (WHERE rn = 3))::text AS top3_amount_rub
    FROM ranked
    WHERE rn <= 3
    GROUP BY stream_start
    ORDER BY stream_start DESC`,
    [year, month, DONATEX_TZ, hideTest, streamWindowsToJsonb(windows)]
  );
}

export type DonateXTopSortField = 'sum' | 'count' | 'date';

/** Топ донатеров за всё время с сортировкой по колонке. */
export async function getTopDonateXDonorsAllTime(options?: {
  limit?: number;
  hideTest?: boolean;
  sortBy?: DonateXTopSortField;
  sortDir?: 'asc' | 'desc';
}): Promise<DonateXDonorRankRow[]> {
  const take = Math.min(100, Math.max(1, options?.limit ?? 20));
  const hideTest = options?.hideTest !== false;
  const sortBy = options?.sortBy ?? 'sum';
  const sortDir = options?.sortDir === 'asc' ? 'ASC' : 'DESC';

  const orderColumn =
    sortBy === 'count'
      ? 'COUNT(*)'
      : sortBy === 'date'
        ? 'MAX(donated_at)'
        : 'SUM(amount_in_rub)';

  const secondaryOrder =
    sortBy === 'sum' ? 'COUNT(*) DESC' : 'SUM(amount_in_rub) DESC';

  return queryDonateX<DonateXDonorRankRow>(
    `SELECT
      username,
      COUNT(*)::int AS donation_count,
      COALESCE(SUM(amount_in_rub), 0)::text AS total_amount_rub,
      MAX(donated_at)::text AS last_donation_at
    FROM donatex_donations
    WHERE ($1::boolean = FALSE OR is_test = FALSE)
    GROUP BY username
    ORDER BY ${orderColumn} ${sortDir}, ${secondaryOrder}
    LIMIT $2`,
    [hideTest, take]
  );
}

export interface DonateXDonationListRow {
  id: string;
  username: string;
  message: string;
  currency: string;
  amount: string;
  amount_in_rub: string;
  donated_at: string;
  is_test: boolean;
  with_ai_response: boolean;
  source: string;
}

export interface DonateXDonationsListResult {
  items: DonateXDonationListRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/** Список донатов для админки (пагинация, поиск, период или календарный день). */
export async function listDonateXDonations(options: {
  page?: number;
  limit?: number;
  search?: string;
  days?: number;
  hideTest?: boolean;
  /** YYYY-MM-DD — день или начало периода в DONATEX_TZ (без days). */
  date?: string;
  /** YYYY-MM-DD — конец периода (включительно); если нет или равна date — один день. */
  dateTo?: string;
}): Promise<DonateXDonationsListResult> {
  const page = Math.max(1, options.page ?? 1);
  const dateFrom = options.date?.trim() ?? '';
  const dateToOpt = options.dateTo?.trim() ?? '';
  const byCalendar = /^\d{4}-\d{2}-\d{2}$/.test(dateFrom);
  const limit = byCalendar
    ? Math.min(500, Math.max(10, options.limit ?? 100))
    : Math.min(100, Math.max(10, options.limit ?? 25));
  const days = Math.min(365, Math.max(1, options.days ?? 30));
  const hideTest = options.hideTest !== false;
  const search = options.search?.trim().slice(0, 200) ?? '';
  const offset = (page - 1) * limit;

  const params: (string | number | boolean)[] = [];
  let where: string;
  let paramIndex = 1;

  if (byCalendar) {
    let rangeStart = dateFrom;
    let rangeEnd =
      /^\d{4}-\d{2}-\d{2}$/.test(dateToOpt) ? dateToOpt : dateFrom;
    if (rangeStart > rangeEnd) {
      const t = rangeStart;
      rangeStart = rangeEnd;
      rangeEnd = t;
    }
    if (rangeStart === rangeEnd) {
      where = `WHERE donated_at >= ($${paramIndex}::date AT TIME ZONE $${paramIndex + 1})
        AND donated_at < (($${paramIndex}::date + INTERVAL '1 day') AT TIME ZONE $${paramIndex + 1})`;
      params.push(rangeStart, DONATEX_TZ);
      paramIndex += 2;
    } else {
      where = `WHERE donated_at >= ($${paramIndex}::date AT TIME ZONE $${paramIndex + 1})
        AND donated_at < (($${paramIndex + 2}::date + INTERVAL '1 day') AT TIME ZONE $${paramIndex + 1})`;
      params.push(rangeStart, DONATEX_TZ, rangeEnd);
      paramIndex += 3;
    }
  } else {
    params.push(days);
    where = `WHERE donated_at >= NOW() - ($1::int * INTERVAL '1 day')`;
    paramIndex = 2;
  }

  if (hideTest) {
    where += ` AND is_test = FALSE`;
  }
  if (search) {
    const pattern = `%${search.toLowerCase()}%`;
    where += ` AND (
      LOWER(username) LIKE $${paramIndex}
      OR LOWER(message) LIKE $${paramIndex}
      OR amount::text LIKE $${paramIndex}
      OR amount_in_rub::text LIKE $${paramIndex}
    )`;
    params.push(pattern);
    paramIndex++;
  }

  const [countRow] = await queryDonateX<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM donatex_donations ${where}`,
    params
  );
  const total = parseInt(countRow?.count ?? '0', 10) || 0;

  const items = await queryDonateX<DonateXDonationListRow>(
    `SELECT
      id,
      username,
      message,
      currency,
      amount::text AS amount,
      amount_in_rub::text AS amount_in_rub,
      donated_at::text AS donated_at,
      is_test,
      with_ai_response,
      source
    FROM donatex_donations
    ${where}
    ORDER BY donated_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

export async function getDonateXStats(): Promise<{
  donations: number;
  donors: number;
  lastDonationAt: string | null;
}> {
  const [donationsRow] = await queryDonateX<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM donatex_donations`
  );
  const [donorsRow] = await queryDonateX<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM donatex_donors`
  );
  const [lastRow] = await queryDonateX<{ last_at: string | null }>(
    `SELECT MAX(donated_at)::text AS last_at FROM donatex_donations`
  );

  return {
    donations: parseInt(donationsRow?.count ?? '0', 10) || 0,
    donors: parseInt(donorsRow?.count ?? '0', 10) || 0,
    lastDonationAt: lastRow?.last_at ?? null,
  };
}
