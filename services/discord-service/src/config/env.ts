import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { AppConfig } from '../types/config';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_LOCAL = NODE_ENV === 'development';

function resolveServiceRoot(): string {
  const fromModule = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(fromModule, 'package.json'))) {
    return fromModule;
  }
  return process.cwd();
}

function resolveMonorepoRoot(): string {
  const serviceRoot = resolveServiceRoot();
  let root = path.resolve(serviceRoot, '..', '..');
  if (fs.existsSync(path.join(root, 'services')) && fs.existsSync(path.join(root, 'package.json'))) {
    return root;
  }
  root = path.resolve(serviceRoot, '..', '..', '..');
  if (fs.existsSync(path.join(root, 'services')) && fs.existsSync(path.join(root, 'package.json'))) {
    return root;
  }
  return path.resolve(serviceRoot, '..', '..');
}

const SERVICE_ROOT = resolveServiceRoot();
const MONOREPO_ROOT = resolveMonorepoRoot();
const envFile = IS_LOCAL ? '.env.local' : '.env';
const monorepoEnvPath = path.resolve(MONOREPO_ROOT, envFile);
const serviceEnvPath = path.resolve(SERVICE_ROOT, envFile);

if (fs.existsSync(monorepoEnvPath)) {
  dotenv.config({ path: monorepoEnvPath });
}

if (fs.existsSync(serviceEnvPath)) {
  dotenv.config({ path: serviceEnvPath });
}

const loadedFrom = fs.existsSync(serviceEnvPath)
  ? serviceEnvPath
  : fs.existsSync(monorepoEnvPath)
    ? monorepoEnvPath
    : serviceEnvPath;

console.log(`[ENV] Discord service (NODE_ENV=${NODE_ENV}), конфиг: ${loadedFrom}`);

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const value = parseInt(raw.trim(), 10);
  if (Number.isNaN(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} не найден! Добавьте в ${serviceEnvPath} или в ${monorepoEnvPath} (корень монорепо).`
    );
  }

  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }

  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes') {
    return true;
  }

  if (value === '0' || value === 'false' || value === 'no') {
    return false;
  }

  return fallback;
}

export function loadConfig(): AppConfig {
  const isLocal = IS_LOCAL;

  return {
    botToken: requireEnv('DISCORD_BOT_TOKEN'),
    guildId: requireEnv('DISCORD_GUILD_ID'),
    voiceChannelId: requireEnv('DISCORD_VOICE_CHANNEL_ID'),
    checkIntervalMs: parsePositiveInt(process.env.DISCORD_GUARD_CHECK_INTERVAL_MS, 60_000),
    reconnectDelayMs: parsePositiveInt(process.env.DISCORD_GUARD_RECONNECT_DELAY_MS, 5_000),
    statusLogIntervalMs: parsePositiveInt(process.env.DISCORD_GUARD_STATUS_LOG_INTERVAL_MS, 900_000),
    leaveOnStop: parseBoolean(process.env.DISCORD_GUARD_LEAVE_ON_STOP, !isLocal),
    nodeEnv: NODE_ENV,
    isLocal,
  };
}

export { NODE_ENV, IS_LOCAL, SERVICE_ROOT, MONOREPO_ROOT };
