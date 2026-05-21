import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

const MONOREPO_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'services')) && fs.existsSync(path.join(cwd, 'package.json'))) {
    return cwd;
  }
  const projectRoot = path.resolve(cwd, '..', '..');
  if (fs.existsSync(path.join(projectRoot, 'services')) && fs.existsSync(path.join(projectRoot, 'package.json'))) {
    return projectRoot;
  }
  return cwd;
})();

const envBasePath = path.join(MONOREPO_ROOT, '.env');
const envLocalPath = path.join(MONOREPO_ROOT, '.env.local');
dotenv.config({ path: envBasePath });
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: true });
}

/** Отдельная БД DonateX; иначе та же строка, что у twitch-bot. */
const DONATEX_DATABASE_URL =
  process.env.DONATEX_DATABASE_URL?.trim() ||
  process.env.TWITCH_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  undefined;

export function getDonateXDatabaseUrl(): string | undefined {
  return DONATEX_DATABASE_URL;
}

let pool: Pool | null = null;
let closingPool = false;

export function getDonateXPool(): Pool | null {
  if (!DONATEX_DATABASE_URL) {
    return null;
  }
  if (!pool) {
    pool = new Pool({ connectionString: DONATEX_DATABASE_URL });
    console.log('[DONATEX_DB] Подключение к PostgreSQL (DonateX)');
  }
  return pool;
}

export async function queryDonateX<T = unknown>(text: string, params?: unknown[]): Promise<T[]> {
  const p = getDonateXPool();
  if (!p) {
    return [];
  }
  const result = await p.query(text, params);
  return result.rows as T[];
}

export async function initDonateXDatabase(): Promise<boolean> {
  const p = getDonateXPool();
  if (!p) {
    console.log('⚠️ [DONATEX_DB] DONATEX_DATABASE_URL / DATABASE_URL не задан — DonateX без БД');
    return false;
  }

  const client = await p.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS donatex_donations (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        amount_in_rub NUMERIC(18, 2) NOT NULL,
        donated_at TIMESTAMPTZ NOT NULL,
        with_ai_response BOOLEAN NOT NULL DEFAULT FALSE,
        ai_response TEXT,
        is_test BOOLEAN NOT NULL DEFAULT FALSE,
        source TEXT NOT NULL DEFAULT 'api_backfill',
        raw_payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS donatex_donors (
        username TEXT PRIMARY KEY,
        donation_count INTEGER NOT NULL DEFAULT 0,
        total_amount_rub NUMERIC(18, 2) NOT NULL DEFAULT 0,
        total_by_currency JSONB NOT NULL DEFAULT '{}'::jsonb,
        first_donation_at TIMESTAMPTZ,
        last_donation_at TIMESTAMPTZ,
        last_message TEXT,
        last_currency TEXT,
        last_amount NUMERIC(18, 2),
        test_donation_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_donatex_donations_username ON donatex_donations(username)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_donatex_donations_donated_at ON donatex_donations(donated_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_donatex_donors_total_rub ON donatex_donors(total_amount_rub DESC)`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS donatex_daytop_points_config (
        id TEXT PRIMARY KEY,
        points_top1 INTEGER NOT NULL DEFAULT 3,
        points_top2 INTEGER NOT NULL DEFAULT 2,
        points_top3 INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `INSERT INTO donatex_daytop_points_config (id, points_top1, points_top2, points_top3)
       VALUES ('default', 3, 2, 1)
       ON CONFLICT (id) DO NOTHING`
    );

    console.log('✅ [DONATEX_DB] Таблицы donatex_donations / donatex_donors готовы');
    return true;
  } finally {
    client.release();
  }
}

export async function closeDonateXDatabase(): Promise<void> {
  if (!pool || closingPool) {
    return;
  }
  closingPool = true;
  try {
    await pool.end();
    pool = null;
    console.log('[DONATEX_DB] Подключение закрыто');
  } finally {
    closingPool = false;
  }
}
