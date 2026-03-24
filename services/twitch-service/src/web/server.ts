import express, { Request, Response } from 'express';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import WebSocket from 'ws';
import { query, queryOne } from '../database/database';

const app = express();
const PORT = parseInt(String(process.env.WEB_PORT || 3000), 10) || 3000;

// WebSocket для реал-тайм обновлений (например, список забаненных по дуэлям) — только по событиям (дуэль/амнистия)
const WS_PATH = '/ws';
let wss: WebSocket.Server | null = null;
let broadcastDuelBannedChanged: (() => void) | null = null;

// === Авторизация админки: admin_users в БД + JWT ===
const JWT_SECRET = process.env.JWT_SECRET ?? (process.env.NODE_ENV === 'production' ? undefined : 'dev-secret-change-in-prod');
const isProd = process.env.NODE_ENV === 'production';
const JWT_EXPIRES_IN = '7d';

interface JwtPayload {
  userId: number;
  username: string;
}

/** Middleware: проверяет JWT Bearer-токен */
function requireAdmin(req: Request, res: Response, next: () => void): void {
  const authHeader = req.headers.authorization;
  const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
  if (!token || !JWT_SECRET) {
    res.status(401).json({ error: 'Требуется авторизация' });
    return;
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    (req as Request & { adminUser?: JwtPayload }).adminUser = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Требуется авторизация' });
  }
}

/** Rate limit для логина: 5 попыток в минуту с IP */
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW_MS = 60_000;

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return true;
  if (now > entry.resetAt) {
    loginAttempts.delete(ip);
    return true;
  }
  return entry.count < LOGIN_RATE_LIMIT;
}

function recordLoginAttempt(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_RATE_WINDOW_MS });
  } else {
    entry.count++;
  }
}

// Middleware
app.use(express.json());
// Статика с долгим кешем — фон и ассеты не перезапрашиваются при переходах
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1y', immutable: true }));

// OAuth-страница (twitch-oauth.html) отдаётся как отдельный маршрут,
// чтобы можно было открыть её по http/https (а не file://) и получить корректный redirect_uri.
app.get('/twitch-oauth.html', (req, res) => {
  const candidates = [
    path.resolve(process.cwd(), 'twitch-oauth.html'),
    path.resolve(__dirname, '..', '..', 'twitch-oauth.html'),
  ];
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    res.status(404).send('twitch-oauth.html not found');
    return;
  }
  res.sendFile(filePath);
});

function computeOAuthRedirectUri(req: Request): string {
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = typeof protoHeader === 'string' && protoHeader ? protoHeader : req.protocol;
  return `${proto}://${req.get('host')}/api/twitch-oauth/callback`;
}

function maskSecret(value: string, head: number = 6, tail: number = 4): string {
  if (!value) return '';
  const v = String(value);
  if (v.length <= head + tail) return `${v.slice(0, head)}...`;
  return `${v.slice(0, head)}...${v.slice(-tail)}`;
}

// Конфиг OAuth для фронта (чтобы не хардкодить CLIENT_ID в twitch-oauth.html)
app.get('/api/twitch-oauth/config', (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ error: 'TWITCH_CLIENT_ID не задан в .env/.env.local' });
    return;
  }
  const redirectUri = computeOAuthRedirectUri(req);
  console.log('[OAUTH][config]', {
    clientId,
    redirectUri,
    hasClientSecret: Boolean(process.env.TWITCH_CLIENT_SECRET),
  });
  res.json({
    clientId,
    redirectUri,
  });
});

const TWITCH_TOKEN_FILE = path.resolve(process.cwd(), 'src', 'data', 'twitch-oauth-tokens.json');

// Callback для OAuth Authorization Code flow.
// Обменивает code -> access_token + refresh_token и сохраняет в JSON файл.
app.get('/api/twitch-oauth/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) {
    res.status(400).send('Missing "code" in query');
    return;
  }

  try {
    console.log('[OAUTH][callback] start', {
      codeLength: code.length,
      hasClientSecret: Boolean(process.env.TWITCH_CLIENT_SECRET),
    });

    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.status(500).send('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env/.env.local');
      return;
    }

    const redirectUri = computeOAuthRedirectUri(req);
    console.log('[OAUTH][callback] computed redirectUri', { redirectUri });

    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }).toString(),
    });

    console.log('[OAUTH][callback] tokenRes status', { status: tokenRes.status, ok: tokenRes.ok });

    const tokenData = await tokenRes.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok) {
      console.error('[OAUTH][callback] token exchange failed', {
        error: tokenData.error || null,
        error_description: tokenData.error_description || null,
      });
    }

    if (!tokenRes.ok || !tokenData.access_token || !tokenData.refresh_token) {
      res.status(400).send(
        `OAuth exchange failed: ${tokenData.error || 'unknown'}${tokenData.error_description ? `: ${tokenData.error_description}` : ''}`,
      );
      return;
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;

    console.log('[OAUTH][callback] tokens received', {
      accessToken: maskSecret(accessToken),
      refreshToken: maskSecret(refreshToken),
      expiresIn: tokenData.expires_in ?? null,
    });

    // Получаем реальные выданные scope'ы + логин/юзер id для удобства
    const validateRes = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: {
        Authorization: `OAuth ${accessToken}`,
      },
    });
    const validateJson = await validateRes.json() as { scopes?: string[]; login?: string; user_id?: string; client_id?: string };

    console.log('[OAUTH][callback] validateRes', {
      status: validateRes.status,
      ok: validateRes.ok,
      grantedScopesCount: Array.isArray(validateJson.scopes) ? validateJson.scopes.length : null,
      login: validateJson.login || null,
      userId: validateJson.user_id || null,
    });

    const payload = {
      createdAt: new Date().toISOString(),
      accessToken,
      refreshToken,
      expiresIn: tokenData.expires_in ?? null,
      grantedScopes: Array.isArray(validateJson.scopes) ? validateJson.scopes : [],
      login: validateJson.login ?? null,
      userId: validateJson.user_id ?? null,
      clientId: validateJson.client_id ?? clientId,
      redirectUri,
    };

    fs.mkdirSync(path.dirname(TWITCH_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TWITCH_TOKEN_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    console.log('[OAUTH][callback] saved JSON', { file: TWITCH_TOKEN_FILE });

    const scopesLine = payload.grantedScopes.length ? payload.grantedScopes.join(', ') : '(пусто)';
    res.send(`
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Twitch OAuth tokens saved</title>
  <style>
    body { font-family: Segoe UI, Tahoma, Geneva, Verdana, sans-serif; margin: 24px; }
    .ok { background: #d4edda; border: 1px solid #c3e6cb; padding: 14px 16px; border-radius: 8px; margin-bottom: 16px; }
    .warn { background: #fff3cd; border: 1px solid #ffeaa7; padding: 14px 16px; border-radius: 8px; margin-bottom: 16px; }
    .box { margin: 12px 0; padding: 14px 16px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e9ecef; }
    code { font-family: Menlo, Consolas, monospace; word-break: break-all; }
    .row { margin-top: 8px; }
    .small { color: #666; font-size: 13px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="ok"><strong>Готово:</strong> токены успешно обменялись и сохранены в JSON файл.</div>
  <div class="warn"><strong>Важно:</strong> не публикуй этот экран/файл. refresh_token — секрет.</div>

  <div class="box">
    <div><strong>JSON файл:</strong> <code>${TWITCH_TOKEN_FILE}</code></div>
    <div class="row"><strong>Login:</strong> <code>${payload.login ?? ''}</code></div>
    <div class="row"><strong>User ID:</strong> <code>${payload.userId ?? ''}</code></div>
    <div class="row"><strong>Granted scopes:</strong> <div class="small"><code>${scopesLine}</code></div></div>
  </div>

  <div class="box">
    <div><strong>TWITCH_ACCESS_TOKEN (access_token):</strong></div>
    <div class="row"><code>${accessToken}</code></div>
  </div>

  <div class="box">
    <div><strong>TWITCH_REFRESH_TOKEN (refresh_token):</strong></div>
    <div class="row"><code>${refreshToken}</code></div>
  </div>

  <div class="box">
    <div><strong>Expires in:</strong> <code>${payload.expiresIn ?? ''}</code></div>
    <div class="small">После вставки в .env перезапусти twitch-service.</div>
  </div>
</body>
</html>
    `);
  } catch (err: any) {
    res.status(500).send(`OAuth callback error: ${err?.message || String(err)}`);
  }
});

// Лимиты для защиты от злоупотреблений
const MAX_ID_LENGTH = 80;
const MAX_TRIGGER_LENGTH = 80;
const MAX_RESPONSE_LENGTH = 8000;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_ALIASES = 30;
const MAX_TEXT_LENGTH = 2000; // party items, link whitelist patterns

function sanitizeString(s: unknown, maxLen: number): string {
  if (typeof s !== 'string') return '';
  return s.slice(0, maxLen).trim();
}

// Защита API: все маршруты кроме /api/auth, /api/leaderboard, /ws требуют авторизации
app.use('/api/admin', requireAdmin);
app.use('/api/commands', requireAdmin);
app.use('/api/counters', requireAdmin);
app.use('/api/links', requireAdmin);
app.use('/api/raid', requireAdmin);
app.use('/api/party', requireAdmin);
app.use('/api/journal', requireAdmin);
app.use('/api/admin-journal', requireAdmin);

function logAdminAction(adminUsername: string, action: string, details: string = ''): void {
    const safeAdmin = String(adminUsername ?? '').slice(0, 255).trim() || 'unknown';
    const rawAction = String(action ?? '').slice(0, 255).trim();
    const safeAction = rawAction ? rawAction.slice(0, 1).toUpperCase() + rawAction.slice(1) : '';
    const safeDetails = String(details ?? '').slice(0, 2000).trim();
    if (!safeAction) return;
    void query(
        `INSERT INTO admin_action_journal (admin_username, action, details) VALUES ($1, $2, $3)`,
        [safeAdmin, safeAction, safeDetails]
    ).catch((err) => {
        console.error('❌ Ошибка записи в журнал админа:', err?.message || err);
    });
}

function shortAuditText(value: unknown, maxLen: number = 60): string {
    const text = String(value ?? '');
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}...`;
}

type PartyConfigAuditSnapshot = {
    enabled: boolean;
    trigger: string;
    response_text: string;
    elements_count: number;
    quantity_max: number;
    skip_cooldown: boolean;
};

type LinksConfigAuditSnapshot = { all_links_text: string; rotation_interval_minutes: number };
type RaidConfigAuditSnapshot = { raid_message: string };
type DuelConfigAuditSnapshot = {
    timeout_minutes: number;
    win_points: number;
    loss_points: number;
    miss_penalty: number;
    raid_duel_boost_enabled: boolean;
    raid_duel_boost_win_percent: number;
    raid_duel_boost_duration_minutes: number;
    raid_duel_boost_min_viewers: number;
};
type DuelDailyConfigAuditSnapshot = {
    daily_games_count: number;
    daily_reward_points: number;
    streak_wins_count: number;
    streak_reward_points: number;
};
type ChatModerationAuditSnapshot = {
    moderation_enabled: boolean;
    check_symbols: boolean;
    check_letters: boolean;
    check_links: boolean;
    max_message_length: number;
    max_letters_digits: number;
    timeout_minutes: number;
};
type CommandAuditSnapshot = {
    id: string;
    trigger: string;
    response: string;
    enabled: boolean;
    cooldown: number;
    message_type: string;
    color: string;
    description: string;
    in_rotation: boolean;
    access_level: string;
};
type CounterAuditSnapshot = {
    id: string;
    trigger: string;
    response_template: string;
    enabled: boolean;
    value: number;
    description: string;
    access_level: string;
};
type AdminAuditContext = {
    previousPartyConfig?: PartyConfigAuditSnapshot | null;
    previousLinksConfig?: LinksConfigAuditSnapshot | null;
    previousRaidConfig?: RaidConfigAuditSnapshot | null;
    previousDuelConfig?: DuelConfigAuditSnapshot | null;
    previousDuelDailyConfig?: DuelDailyConfigAuditSnapshot | null;
    previousChatModerationConfig?: ChatModerationAuditSnapshot | null;
    previousCommand?: CommandAuditSnapshot | null;
    previousCounter?: CounterAuditSnapshot | null;
    previousWhitelistCount?: number;
    previousPartyItem?: { id: number; text: string } | null;
};

async function loadAdminAuditContext(req: Request): Promise<AdminAuditContext> {
    const method = req.method.toUpperCase();
    const pathOnly = req.originalUrl.split('?')[0];
    const pathParts = pathOnly.split('/').filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1] || '';
    const prevPart = pathParts[pathParts.length - 2] || '';

    const ctx: AdminAuditContext = {};
    if (method === 'PUT' && pathOnly === '/api/party/config') {
        ctx.previousPartyConfig = await queryOne<PartyConfigAuditSnapshot>(
            'SELECT enabled, trigger, response_text, elements_count, quantity_max, skip_cooldown FROM party_config WHERE id = 1'
        );
    }
    if (method === 'PUT' && pathOnly === '/api/links') {
        ctx.previousLinksConfig = await queryOne<LinksConfigAuditSnapshot>(
            'SELECT all_links_text, rotation_interval_minutes FROM links_config WHERE id = 1'
        );
    }
    if (method === 'PUT' && pathOnly === '/api/raid') {
        ctx.previousRaidConfig = await queryOne<RaidConfigAuditSnapshot>(
            'SELECT raid_message FROM raid_config WHERE id = 1'
        );
    }
    if (method === 'POST' && pathOnly === '/api/admin/duels/config') {
        ctx.previousDuelConfig = await queryOne<DuelConfigAuditSnapshot>(
            'SELECT timeout_minutes, win_points, loss_points, miss_penalty, raid_duel_boost_enabled, raid_duel_boost_win_percent, raid_duel_boost_duration_minutes, raid_duel_boost_min_viewers FROM duel_config WHERE id = 1'
        );
    }
    if (method === 'POST' && pathOnly === '/api/admin/duels/daily-config') {
        ctx.previousDuelDailyConfig = await queryOne<DuelDailyConfigAuditSnapshot>(
            'SELECT daily_games_count, daily_reward_points, streak_wins_count, streak_reward_points FROM duel_daily_config WHERE id = 1'
        );
    }
    if (method === 'POST' && pathOnly === '/api/admin/chat-moderation/config') {
        ctx.previousChatModerationConfig = await queryOne<ChatModerationAuditSnapshot>(
            'SELECT moderation_enabled, check_symbols, check_letters, check_links, max_message_length, max_letters_digits, timeout_minutes FROM chat_moderation_config WHERE id = 1'
        );
    }
    if (method === 'POST' && pathOnly === '/api/admin/link-whitelist') {
        const row = await queryOne<{ count: number }>('SELECT COUNT(*)::int AS count FROM link_whitelist');
        ctx.previousWhitelistCount = row?.count ?? 0;
    }
    if ((method === 'PUT' || method === 'DELETE') && pathOnly.startsWith('/api/party/items/')) {
        const itemId = Number.parseInt(decodeURIComponent(lastPart), 10);
        if (!Number.isNaN(itemId)) {
            ctx.previousPartyItem = await queryOne<{ id: number; text: string }>(
                'SELECT id, text FROM party_items WHERE id = $1',
                [itemId]
            );
        }
    }
    if (method === 'PUT' && pathOnly.startsWith('/api/commands/')) {
        ctx.previousCommand = await queryOne<CommandAuditSnapshot>(
            'SELECT id, trigger, response, enabled, cooldown, message_type, color, description, in_rotation, access_level FROM custom_commands WHERE LOWER(id) = LOWER($1)',
            [decodeURIComponent(lastPart)]
        );
    }
    if (method === 'PATCH' && pathOnly.startsWith('/api/commands/') && (pathOnly.endsWith('/toggle') || pathOnly.endsWith('/rotation-toggle'))) {
        ctx.previousCommand = await queryOne<CommandAuditSnapshot>(
            'SELECT id, trigger, response, enabled, cooldown, message_type, color, description, in_rotation, access_level FROM custom_commands WHERE LOWER(id) = LOWER($1)',
            [decodeURIComponent(prevPart)]
        );
    }
    if (method === 'PUT' && pathOnly.startsWith('/api/counters/')) {
        ctx.previousCounter = await queryOne<CounterAuditSnapshot>(
            'SELECT id, trigger, response_template, enabled, value, description, access_level FROM counters WHERE LOWER(id) = LOWER($1)',
            [decodeURIComponent(lastPart)]
        );
    }
    if (method === 'PATCH' && pathOnly.startsWith('/api/counters/') && pathOnly.endsWith('/toggle')) {
        ctx.previousCounter = await queryOne<CounterAuditSnapshot>(
            'SELECT id, trigger, response_template, enabled, value, description, access_level FROM counters WHERE LOWER(id) = LOWER($1)',
            [decodeURIComponent(prevPart)]
        );
    }
    return ctx;
}

function describeAdminAction(req: Request, context?: AdminAuditContext): { action: string; details?: string } {
    const method = req.method.toUpperCase();
    const pathOnly = req.originalUrl.split('?')[0];
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pathParts = pathOnly.split('/').filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1] || '';
    const prevPart = pathParts[pathParts.length - 2] || '';

    if (method === 'POST' && pathOnly === '/api/admin/duels/disable') {
        return { action: 'выключил дуэли' };
    }
    if (method === 'POST' && pathOnly === '/api/admin/duels/enable') {
        return { action: 'включил дуэли' };
    }
    if (method === 'POST' && pathOnly === '/api/admin/duels/set-cooldown-skip') {
        const skip = Boolean(body.skip);
        const before = getDuelCooldownSkipCallback ? getDuelCooldownSkipCallback() : false;
        return {
            action: skip ? 'выключил КД дуэлей' : 'включил КД дуэлей',
            details: `КД: ${before ? 'выкл' : 'вкл'} -> ${skip ? 'выкл' : 'вкл'}`,
        };
    }
    if (method === 'POST' && pathOnly === '/api/admin/duels/set-overlay-sync') {
        const enabled = Boolean(body.enabled);
        const before = getDuelOverlaySyncEnabledCallback ? getDuelOverlaySyncEnabledCallback() : false;
        return {
            action: enabled ? 'включил синхронизацию дуэлей с оверлеем' : 'выключил синхронизацию дуэлей с оверлеем',
            details: `Синхронизация: ${before ? 'вкл' : 'выкл'} -> ${enabled ? 'вкл' : 'выкл'}`,
        };
    }
    if (method === 'PUT' && pathOnly === '/api/links') {
        const prev = context?.previousLinksConfig;
        const hasText = typeof body.allLinksText === 'string';
        const hasRotation = typeof body.rotationIntervalMinutes === 'number';
        const textChanged = hasText && (!prev || prev.all_links_text !== String(body.allLinksText));
        const rotationChanged = hasRotation && (!prev || prev.rotation_interval_minutes !== Number(body.rotationIntervalMinutes));
        if (textChanged && rotationChanged) {
            return {
                action: 'обновил ссылки и интервал ротации',
                details: prev
                    ? `Интервал: ${prev.rotation_interval_minutes} -> ${Number(body.rotationIntervalMinutes)} мин; текст ссылок: "${shortAuditText(prev.all_links_text)}" -> "${shortAuditText(body.allLinksText)}"`
                    : `Интервал: ${Number(body.rotationIntervalMinutes)} мин; текст ссылок: "${shortAuditText(body.allLinksText)}"`,
            };
        }
        if (rotationChanged) {
            return {
                action: 'поменял время ротации ссылок',
                details: prev
                    ? `Интервал: ${prev.rotation_interval_minutes} -> ${Number(body.rotationIntervalMinutes)} мин`
                    : `Интервал: ${Number(body.rotationIntervalMinutes)} мин`,
            };
        }
        if (textChanged) {
            return {
                action: 'обновил текст команды !ссылки',
                details: prev
                    ? `Текст: "${shortAuditText(prev.all_links_text)}" -> "${shortAuditText(body.allLinksText)}"`
                    : `Текст: "${shortAuditText(body.allLinksText)}"`,
            };
        }
        return { action: 'сохранил ссылки без изменений' };
    }
    if (method === 'PUT' && pathOnly === '/api/raid') {
        const prev = context?.previousRaidConfig;
        if (typeof body.raidMessage === 'string') {
            if (!prev || prev.raid_message !== body.raidMessage) {
                return {
                    action: 'обновил сообщение при рейде',
                    details: prev
                        ? `Сообщение: "${shortAuditText(prev.raid_message)}" -> "${shortAuditText(body.raidMessage)}"`
                        : `Сообщение: "${shortAuditText(body.raidMessage)}"`,
                };
            }
            return { action: 'сохранил сообщение рейда без изменений' };
        }
        return { action: 'обновил сообщение при рейде' };
    }
    if (method === 'POST' && pathOnly === '/api/commands') {
        return { action: 'создал команду', details: `ID: ${String(body.id ?? '').slice(0, 80)}` };
    }
    if (method === 'PUT' && pathOnly.startsWith('/api/commands/')) {
        const prev = context?.previousCommand;
        const changes: string[] = [];
        if (prev) {
            if (body.trigger != null && String(body.trigger) !== prev.trigger) changes.push(`триггер: ${prev.trigger} -> ${String(body.trigger)}`);
            if (body.response != null && String(body.response) !== prev.response) {
                changes.push(`ответ: "${shortAuditText(prev.response)}" -> "${shortAuditText(body.response)}"`);
            }
            if (body.enabled != null && Boolean(body.enabled) !== prev.enabled) changes.push(`статус: ${prev.enabled ? 'вкл' : 'выкл'} -> ${Boolean(body.enabled) ? 'вкл' : 'выкл'}`);
            if (body.cooldown != null && Number(body.cooldown) !== prev.cooldown) changes.push(`кд: ${prev.cooldown}с -> ${Number(body.cooldown)}с`);
            if (body.accessLevel != null && String(body.accessLevel) !== prev.access_level) changes.push(`доступ: ${prev.access_level} -> ${String(body.accessLevel)}`);
            if (body.messageType != null && String(body.messageType) !== prev.message_type) changes.push(`тип: ${prev.message_type} -> ${String(body.messageType)}`);
            if (body.color != null && String(body.color) !== prev.color) changes.push(`цвет: ${prev.color} -> ${String(body.color)}`);
            if (body.description != null && String(body.description) !== prev.description) {
                changes.push(`описание: "${shortAuditText(prev.description)}" -> "${shortAuditText(body.description)}"`);
            }
            if (body.inRotation != null && Boolean(body.inRotation) !== prev.in_rotation) changes.push(`ротация: ${prev.in_rotation ? 'вкл' : 'выкл'} -> ${Boolean(body.inRotation) ? 'вкл' : 'выкл'}`);
        }
        if (changes.length === 0) return { action: 'сохранил команду без изменений', details: `ID: ${decodeURIComponent(lastPart)}` };
        return { action: 'обновил команду', details: `ID: ${decodeURIComponent(lastPart)}; ${changes.join(', ')}` };
    }
    if (method === 'DELETE' && pathOnly.startsWith('/api/commands/')) {
        return { action: 'удалил команду', details: `ID: ${decodeURIComponent(lastPart)}` };
    }
    if (method === 'PATCH' && pathOnly.endsWith('/toggle') && pathOnly.startsWith('/api/commands/')) {
        const prev = context?.previousCommand;
        if (prev) {
            return {
                action: 'переключил команду',
                details: `ID: ${decodeURIComponent(prevPart)}; статус: ${prev.enabled ? 'вкл' : 'выкл'} -> ${prev.enabled ? 'выкл' : 'вкл'}`,
            };
        }
        return { action: 'переключил команду', details: `ID: ${decodeURIComponent(prevPart)}` };
    }
    if (method === 'PATCH' && pathOnly.endsWith('/rotation-toggle') && pathOnly.startsWith('/api/commands/')) {
        const prev = context?.previousCommand;
        if (prev) {
            return {
                action: 'переключил ротацию команды',
                details: `ID: ${decodeURIComponent(prevPart)}; ротация: ${prev.in_rotation ? 'вкл' : 'выкл'} -> ${prev.in_rotation ? 'выкл' : 'вкл'}`,
            };
        }
        return { action: 'переключил ротацию команды', details: `ID: ${decodeURIComponent(prevPart)}` };
    }
    if (method === 'POST' && pathOnly.endsWith('/send') && pathOnly.startsWith('/api/commands/')) {
        return { action: 'отправил команду в чат', details: `ID: ${decodeURIComponent(prevPart)}` };
    }
    if (method === 'POST' && pathOnly === '/api/links/send') {
        return { action: 'отправил !ссылки в чат' };
    }
    if (method === 'POST' && pathOnly === '/api/counters') {
        return { action: 'создал счётчик', details: `ID: ${String(body.id ?? '').slice(0, 80)}` };
    }
    if (method === 'PUT' && pathOnly.startsWith('/api/counters/')) {
        const prev = context?.previousCounter;
        const changes: string[] = [];
        if (prev) {
            if (body.trigger != null && String(body.trigger) !== prev.trigger) changes.push(`триггер: ${prev.trigger} -> ${String(body.trigger)}`);
            if (body.responseTemplate != null && String(body.responseTemplate) !== prev.response_template) {
                changes.push(`шаблон: "${shortAuditText(prev.response_template)}" -> "${shortAuditText(body.responseTemplate)}"`);
            }
            if (body.enabled != null && Boolean(body.enabled) !== prev.enabled) changes.push(`статус: ${prev.enabled ? 'вкл' : 'выкл'} -> ${Boolean(body.enabled) ? 'вкл' : 'выкл'}`);
            if (body.value != null && Number(body.value) !== prev.value) changes.push(`значение: ${prev.value} -> ${Number(body.value)}`);
            if (body.accessLevel != null && String(body.accessLevel) !== prev.access_level) changes.push(`доступ: ${prev.access_level} -> ${String(body.accessLevel)}`);
            if (body.description != null && String(body.description) !== prev.description) {
                changes.push(`описание: "${shortAuditText(prev.description)}" -> "${shortAuditText(body.description)}"`);
            }
        }
        if (changes.length === 0) return { action: 'сохранил счётчик без изменений', details: `ID: ${decodeURIComponent(lastPart)}` };
        return { action: 'обновил счётчик', details: `ID: ${decodeURIComponent(lastPart)}; ${changes.join(', ')}` };
    }
    if (method === 'DELETE' && pathOnly.startsWith('/api/counters/')) {
        return { action: 'удалил счётчик', details: `ID: ${decodeURIComponent(lastPart)}` };
    }
    if (method === 'PATCH' && pathOnly.endsWith('/toggle') && pathOnly.startsWith('/api/counters/')) {
        const prev = context?.previousCounter;
        if (prev) {
            return {
                action: 'переключил счётчик',
                details: `ID: ${decodeURIComponent(prevPart)}; статус: ${prev.enabled ? 'вкл' : 'выкл'} -> ${prev.enabled ? 'выкл' : 'вкл'}`,
            };
        }
        return { action: 'переключил счётчик', details: `ID: ${decodeURIComponent(prevPart)}` };
    }
    if (method === 'PATCH' && pathOnly.endsWith('/increment') && pathOnly.startsWith('/api/counters/')) {
        return { action: 'увеличил счётчик', details: `ID: ${decodeURIComponent(prevPart)}` };
    }
    if (method === 'PUT' && pathOnly === '/api/party/config') {
        const changes: string[] = [];
        const prev = context?.previousPartyConfig;
        if (body.enabled != null) {
            const nextEnabled = Boolean(body.enabled);
            if (!prev || prev.enabled !== nextEnabled) {
                changes.push(prev ? `партия: ${prev.enabled ? 'вкл' : 'выкл'} -> ${nextEnabled ? 'вкл' : 'выкл'}` : `партия: ${nextEnabled ? 'вкл' : 'выкл'}`);
            }
        }
        if (body.trigger != null) {
            const nextTrigger = String(body.trigger).trim();
            if (!prev || prev.trigger !== nextTrigger) {
                changes.push(prev ? `триггер: ${prev.trigger} -> ${nextTrigger}` : `триггер: ${nextTrigger}`);
            }
        }
        if (body.responseText != null) {
            const nextResponseText = String(body.responseText);
            if (!prev || prev.response_text !== nextResponseText) {
                changes.push(
                    prev
                        ? `текст ответа: "${shortAuditText(prev.response_text)}" -> "${shortAuditText(nextResponseText)}"`
                        : `текст ответа: "${shortAuditText(nextResponseText)}"`
                );
            }
        }
        if (body.elementsCount != null) {
            const nextElementsCount = Number(body.elementsCount);
            if (!prev || prev.elements_count !== nextElementsCount) {
                changes.push(prev ? `элементов: ${prev.elements_count} -> ${nextElementsCount}` : `элементов: ${nextElementsCount}`);
            }
        }
        if (body.quantityMax != null) {
            const nextQuantityMax = Number(body.quantityMax);
            if (!prev || prev.quantity_max !== nextQuantityMax) {
                changes.push(prev ? `макс. кол-во: ${prev.quantity_max} -> ${nextQuantityMax}` : `макс. кол-во: ${nextQuantityMax}`);
            }
        }
        if (body.skipCooldown != null) {
            const nextSkipCooldown = Boolean(body.skipCooldown);
            if (!prev || prev.skip_cooldown !== nextSkipCooldown) {
                changes.push(prev ? `КД: ${prev.skip_cooldown ? 'выкл' : 'вкл'} -> ${nextSkipCooldown ? 'выкл' : 'вкл'}` : `КД: ${nextSkipCooldown ? 'выкл' : 'вкл'}`);
            }
        }
        if (changes.length === 0) {
            return { action: 'открыл/сохранил настройки партии без изменений' };
        }
        return { action: 'обновил настройки партии', details: changes.join(', ') };
    }
    if (method === 'PATCH' && pathOnly === '/api/party/config/skip-cooldown') {
        const skip = Boolean(body.skipCooldown);
        return { action: skip ? 'выключил КД партии' : 'включил КД партии' };
    }
    if (method === 'POST' && pathOnly === '/api/party/items') {
        const text = typeof body.text === 'string' ? body.text : '';
        return {
            action: 'добавил элемент партии',
            details: text ? `Текст: "${shortAuditText(text)}"` : undefined,
        };
    }
    if (method === 'PUT' && pathOnly.startsWith('/api/party/items/')) {
        const prev = context?.previousPartyItem;
        const nextText = typeof body.text === 'string' ? body.text : '';
        if (prev && nextText && prev.text !== nextText) {
            return {
                action: 'обновил элемент партии',
                details: `ID: ${decodeURIComponent(lastPart)}; Текст: "${shortAuditText(prev.text)}" -> "${shortAuditText(nextText)}"`,
            };
        }
        return { action: 'обновил элемент партии', details: `ID: ${decodeURIComponent(lastPart)}` };
    }
    if (method === 'DELETE' && pathOnly.startsWith('/api/party/items/')) {
        const prev = context?.previousPartyItem;
        return {
            action: 'удалил элемент партии',
            details: prev
                ? `ID: ${decodeURIComponent(lastPart)}; Текст: "${shortAuditText(prev.text)}"`
                : `ID: ${decodeURIComponent(lastPart)}`,
        };
    }
    if (method === 'POST' && pathOnly === '/api/admin/duels/config') {
        const changes: string[] = [];
        const prev = context?.previousDuelConfig;
        if (body.timeoutMinutes != null && (!prev || Number(body.timeoutMinutes) !== prev.timeout_minutes)) changes.push(prev ? `таймаут: ${prev.timeout_minutes} -> ${Number(body.timeoutMinutes)} мин` : `таймаут: ${Number(body.timeoutMinutes)} мин`);
        if (body.winPoints != null && (!prev || Number(body.winPoints) !== prev.win_points)) changes.push(prev ? `очки за победу: ${prev.win_points} -> ${Number(body.winPoints)}` : `очки за победу: ${Number(body.winPoints)}`);
        if (body.lossPoints != null && (!prev || Number(body.lossPoints) !== prev.loss_points)) changes.push(prev ? `очки за поражение: ${prev.loss_points} -> ${Number(body.lossPoints)}` : `очки за поражение: ${Number(body.lossPoints)}`);
        if (body.missPenalty != null && (!prev || Number(body.missPenalty) !== prev.miss_penalty)) changes.push(prev ? `штраф за промах: ${prev.miss_penalty} -> ${Number(body.missPenalty)}` : `штраф за промах: ${Number(body.missPenalty)}`);
        if (body.raidBoostEnabled != null && (!prev || Boolean(body.raidBoostEnabled) !== prev.raid_duel_boost_enabled)) {
            changes.push(
                prev
                    ? `рейд-буст дуэлей: ${prev.raid_duel_boost_enabled ? 'вкл' : 'выкл'} -> ${Boolean(body.raidBoostEnabled) ? 'вкл' : 'выкл'}`
                    : `рейд-буст дуэлей: ${Boolean(body.raidBoostEnabled) ? 'вкл' : 'выкл'}`
            );
        }
        if (body.raidBoostWinPercent != null && (!prev || Number(body.raidBoostWinPercent) !== prev.raid_duel_boost_win_percent)) {
            changes.push(
                prev
                    ? `рейд-буст шанс: ${prev.raid_duel_boost_win_percent}% -> ${Number(body.raidBoostWinPercent)}%`
                    : `рейд-буст шанс: ${Number(body.raidBoostWinPercent)}%`
            );
        }
        if (body.raidBoostDurationMinutes != null && (!prev || Number(body.raidBoostDurationMinutes) !== prev.raid_duel_boost_duration_minutes)) {
            changes.push(
                prev
                    ? `рейд-буст время: ${prev.raid_duel_boost_duration_minutes} -> ${Number(body.raidBoostDurationMinutes)} мин`
                    : `рейд-буст время: ${Number(body.raidBoostDurationMinutes)} мин`
            );
        }
        if (body.raidBoostMinViewers != null && (!prev || Number(body.raidBoostMinViewers) !== prev.raid_duel_boost_min_viewers)) {
            changes.push(
                prev
                    ? `рейд-буст мин. зрителей: ${prev.raid_duel_boost_min_viewers} -> ${Number(body.raidBoostMinViewers)}`
                    : `рейд-буст мин. зрителей: ${Number(body.raidBoostMinViewers)}`
            );
        }
        if (changes.length === 0) return { action: 'сохранил настройки дуэлей без изменений' };
        return {
            action: 'обновил настройки дуэлей',
            details: changes.join(', '),
        };
    }
    if (method === 'POST' && pathOnly === '/api/admin/duels/daily-config') {
        const changes: string[] = [];
        const prev = context?.previousDuelDailyConfig;
        if (body.dailyGamesCount != null && (!prev || Number(body.dailyGamesCount) !== prev.daily_games_count)) changes.push(prev ? `игр в день: ${prev.daily_games_count} -> ${Number(body.dailyGamesCount)}` : `игр в день: ${Number(body.dailyGamesCount)}`);
        if (body.dailyRewardPoints != null && (!prev || Number(body.dailyRewardPoints) !== prev.daily_reward_points)) changes.push(prev ? `награда за дейлик: ${prev.daily_reward_points} -> ${Number(body.dailyRewardPoints)}` : `награда за дейлик: ${Number(body.dailyRewardPoints)}`);
        if (body.streakWinsCount != null && (!prev || Number(body.streakWinsCount) !== prev.streak_wins_count)) changes.push(prev ? `побед для серии: ${prev.streak_wins_count} -> ${Number(body.streakWinsCount)}` : `побед для серии: ${Number(body.streakWinsCount)}`);
        if (body.streakRewardPoints != null && (!prev || Number(body.streakRewardPoints) !== prev.streak_reward_points)) changes.push(prev ? `награда за серию: ${prev.streak_reward_points} -> ${Number(body.streakRewardPoints)}` : `награда за серию: ${Number(body.streakRewardPoints)}`);
        if (changes.length === 0) return { action: 'сохранил дейлики дуэлей без изменений' };
        return {
            action: 'обновил дейлики дуэлей',
            details: changes.join(', '),
        };
    }
    if (method === 'POST' && pathOnly === '/api/admin/chat-moderation/config') {
        const changes: string[] = [];
        const prev = context?.previousChatModerationConfig;
        if (body.moderationEnabled != null && (!prev || Boolean(body.moderationEnabled) !== prev.moderation_enabled)) changes.push(prev ? `модерация: ${prev.moderation_enabled ? 'вкл' : 'выкл'} -> ${Boolean(body.moderationEnabled) ? 'вкл' : 'выкл'}` : `модерация: ${Boolean(body.moderationEnabled) ? 'вкл' : 'выкл'}`);
        if (body.checkSymbols != null && (!prev || Boolean(body.checkSymbols) !== prev.check_symbols)) changes.push(prev ? `символы: ${prev.check_symbols ? 'вкл' : 'выкл'} -> ${Boolean(body.checkSymbols) ? 'вкл' : 'выкл'}` : `символы: ${Boolean(body.checkSymbols) ? 'вкл' : 'выкл'}`);
        if (body.checkLetters != null && (!prev || Boolean(body.checkLetters) !== prev.check_letters)) changes.push(prev ? `буквы/цифры: ${prev.check_letters ? 'вкл' : 'выкл'} -> ${Boolean(body.checkLetters) ? 'вкл' : 'выкл'}` : `буквы/цифры: ${Boolean(body.checkLetters) ? 'вкл' : 'выкл'}`);
        if (body.checkLinks != null && (!prev || Boolean(body.checkLinks) !== prev.check_links)) changes.push(prev ? `ссылки: ${prev.check_links ? 'вкл' : 'выкл'} -> ${Boolean(body.checkLinks) ? 'вкл' : 'выкл'}` : `ссылки: ${Boolean(body.checkLinks) ? 'вкл' : 'выкл'}`);
        if (body.maxMessageLength != null && (!prev || Number(body.maxMessageLength) !== prev.max_message_length)) changes.push(prev ? `лимит сообщения: ${prev.max_message_length} -> ${Number(body.maxMessageLength)}` : `лимит сообщения: ${Number(body.maxMessageLength)}`);
        if (body.maxLettersDigits != null && (!prev || Number(body.maxLettersDigits) !== prev.max_letters_digits)) changes.push(prev ? `лимит букв/цифр: ${prev.max_letters_digits} -> ${Number(body.maxLettersDigits)}` : `лимит букв/цифр: ${Number(body.maxLettersDigits)}`);
        if (body.timeoutMinutes != null && (!prev || Number(body.timeoutMinutes) !== prev.timeout_minutes)) changes.push(prev ? `таймаут: ${prev.timeout_minutes} -> ${Number(body.timeoutMinutes)} мин` : `таймаут: ${Number(body.timeoutMinutes)} мин`);
        if (changes.length === 0) return { action: 'сохранил модерацию чата без изменений' };
        return { action: 'обновил модерацию чата', details: changes.join(', ') };
    }
    if (method === 'POST' && pathOnly === '/api/admin/link-whitelist') {
        const count = Array.isArray(body.patterns) ? body.patterns.length : 0;
        const prev = context?.previousWhitelistCount;
        return {
            action: 'обновил whitelist ссылок',
            details: prev != null ? `Паттернов: ${prev} -> ${count}` : `Паттернов: ${count}`,
        };
    }
    if (method === 'POST' && pathOnly === '/api/admin/duels/reset-reward-flags') {
        return { action: 'сбросил флаги наград дуэлей' };
    }
    if (method === 'POST' && pathOnly === '/api/admin/duels/reset-points') {
        return { action: 'сбросил очки дуэлей' };
    }
    if (method === 'POST' && pathOnly === '/api/admin/pardon-all') {
        return { action: 'запустил амнистию дуэлей' };
    }
    if (method === 'POST' && pathOnly.startsWith('/api/admin/duels/pardon/')) {
        return { action: 'амнистировал игрока', details: `Пользователь: ${decodeURIComponent(lastPart)}` };
    }

    return { action: `${method} ${pathOnly}` };
}

// Автоматический аудит: все успешные mutating-запросы админки пишем в admin_action_journal
app.use((req: Request, res: Response, next: () => void) => {
    const method = req.method.toUpperCase();
    const isMutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const admin = (req as Request & { adminUser?: JwtPayload }).adminUser;
    if (!isMutating || !admin?.username) {
        next();
        return;
    }
    void loadAdminAuditContext(req).then((ctx) => {
        const described = describeAdminAction(req, ctx);
        res.on('finish', () => {
            if (res.statusCode >= 200 && res.statusCode < 400) {
                if (described.action.includes('без изменений')) return;
                logAdminAction(admin.username, described.action, described.details);
            }
        });
        next();
    }).catch(() => {
        const described = describeAdminAction(req);
        res.on('finish', () => {
            if (res.statusCode >= 200 && res.statusCode < 400) {
                if (described.action.includes('без изменений')) return;
                logAdminAction(admin.username, described.action, described.details);
            }
        });
        next();
    });
});

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
    accessLevel: 'everyone' | 'moderators';
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
    accessLevel: 'everyone' | 'moderators';
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
    access_level: string;
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
        accessLevel: (row.access_level as CustomCommand['accessLevel']) ?? 'everyone',
    };
}

async function getAllCommandsFromDb(): Promise<CommandsData> {
    const rows = await query<DbCommandRow>(
        'SELECT id, trigger, aliases, response, enabled, cooldown, message_type, color, description, in_rotation, access_level FROM custom_commands ORDER BY id',
    );
    return { commands: rows.map(mapDbRowToCommand) };
}

async function getCommandByIdFromDb(id: string): Promise<CustomCommand | null> {
    const row = await queryOne<DbCommandRow>(
        'SELECT id, trigger, aliases, response, enabled, cooldown, message_type, color, description, in_rotation, access_level FROM custom_commands WHERE id = $1',
        [id],
    );
    return row ? mapDbRowToCommand(row) : null;
}

async function createCommandInDb(cmd: CustomCommand): Promise<void> {
    await query(
        `INSERT INTO custom_commands
          (id, trigger, aliases, response, enabled, cooldown, message_type, color, description, in_rotation, access_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
            cmd.accessLevel ?? 'everyone',
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
             in_rotation = $10,
             access_level = $11
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
            mergedWithRotation.accessLevel ?? 'everyone',
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
    access_level: string;
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
        accessLevel: (row.access_level as Counter['accessLevel']) ?? 'everyone',
    };
}

async function getAllCountersFromDb(): Promise<CountersData> {
    const rows = await query<DbCounterRow>(
        'SELECT id, trigger, aliases, response_template, value, enabled, description, access_level FROM counters ORDER BY id',
    );
    return { counters: rows.map(mapDbRowToCounter) };
}

async function getCounterByIdFromDb(id: string): Promise<Counter | null> {
    const row = await queryOne<DbCounterRow>(
        'SELECT id, trigger, aliases, response_template, value, enabled, description, access_level FROM counters WHERE id = $1',
        [id],
    );
    return row ? mapDbRowToCounter(row) : null;
}

async function createCounterInDb(counter: Counter): Promise<void> {
    await query(
        `INSERT INTO counters
          (id, trigger, aliases, response_template, value, enabled, description, access_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
            counter.id,
            counter.trigger,
            counter.aliases ?? [],
            counter.responseTemplate,
            counter.value ?? 0,
            counter.enabled ?? true,
            counter.description ?? '',
            counter.accessLevel ?? 'everyone',
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
             description = $7,
             access_level = $8
         WHERE id = $1`,
        [
            merged.id,
            merged.trigger,
            merged.aliases ?? [],
            merged.responseTemplate,
            merged.value,
            merged.enabled,
            merged.description ?? '',
            merged.accessLevel ?? 'everyone',
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

interface RaidConfig {
    raidMessage: string;
}

async function getRaidFromDb(): Promise<RaidConfig> {
    try {
        const row = await queryOne<{ raid_message: string }>(
            'SELECT raid_message FROM raid_config WHERE id = 1'
        );
        return { raidMessage: row?.raid_message ?? '' };
    } catch (error) {
        console.error('⚠️ Ошибка загрузки raid_config из БД:', error);
        return { raidMessage: '' };
    }
}

async function saveRaidToDb(config: RaidConfig): Promise<boolean> {
    try {
        await query(
            `INSERT INTO raid_config (id, raid_message) VALUES (1, $1)
             ON CONFLICT (id) DO UPDATE SET raid_message = EXCLUDED.raid_message`,
            [String(config.raidMessage ?? '').slice(0, 500)]
        );
        return true;
    } catch (error) {
        console.error('⚠️ Ошибка сохранения raid_config в БД:', error);
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
        if (allLinksText.length > 50000) {
            return res.status(400).json({ error: 'Текст ссылок слишком длинный' });
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

// === API для блока "Рейд" (хранится в БД raid_config) ===

app.get('/api/raid', async (req: Request, res: Response) => {
    try {
        const config = await getRaidFromDb();
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка загрузки настроек рейда' });
    }
});

app.put('/api/raid', async (req: Request, res: Response) => {
    try {
        const { raidMessage } = req.body as Partial<RaidConfig>;
        const safeMessage = typeof raidMessage === 'string' ? raidMessage.slice(0, 500) : '';
        if (await saveRaidToDb({ raidMessage: safeMessage })) {
            console.log('✅ Конфиг рейда обновлён (БД)');
            if (onRaidConfigUpdatedCallback) {
                try {
                    onRaidConfigUpdatedCallback({ raidMessage: safeMessage });
                } catch (cbError) {
                    console.error('⚠️ Ошибка в onRaidConfigUpdatedCallback:', cbError);
                }
            }
            res.json({ raidMessage: safeMessage });
        } else {
            res.status(500).json({ error: 'Ошибка сохранения настроек рейда' });
        }
    } catch (error) {
        console.error('❌ Ошибка обновления настроек рейда:', error);
        res.status(500).json({ error: 'Ошибка обновления настроек рейда' });
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
        const safeId = sanitizeString(newCommand.id, MAX_ID_LENGTH);
        const safeTrigger = sanitizeString(newCommand.trigger, MAX_TRIGGER_LENGTH);
        const safeResponse = sanitizeString(newCommand.response, MAX_RESPONSE_LENGTH);
        if (!safeId || !safeTrigger || !safeResponse) {
            return res.status(400).json({ error: 'id, trigger и response не должны быть пустыми' });
        }
        if (Array.isArray(newCommand.aliases) && newCommand.aliases.length > MAX_ALIASES) {
            return res.status(400).json({ error: `Максимум ${MAX_ALIASES} алиасов` });
        }
        const cooldown = Number(newCommand.cooldown);
        if (!Number.isNaN(cooldown) && (cooldown < 0 || cooldown > 3600)) {
            return res.status(400).json({ error: 'Кулдаун должен быть от 0 до 3600 сек' });
        }
        const accessLevel = newCommand.accessLevel === 'moderators' ? 'moderators' : 'everyone';

        // Проверка на дубликат ID
        const existingById = await getCommandByIdFromDb(safeId);
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
            [safeTrigger],
        );

        if (triggerCheck) {
            return res.status(400).json({
                error: `Триггер "${safeTrigger}" уже используется командой "${triggerCheck.id}"`,
            });
        }

        const safeAliases = Array.isArray(newCommand.aliases)
            ? newCommand.aliases.slice(0, MAX_ALIASES).map((a) => sanitizeString(a, MAX_TRIGGER_LENGTH)).filter(Boolean)
            : [];
        const toSave: CustomCommand = {
            ...newCommand,
            id: safeId,
            trigger: safeTrigger,
            response: safeResponse,
            description: sanitizeString(newCommand.description, MAX_DESCRIPTION_LENGTH) || '',
            aliases: safeAliases,
            enabled: newCommand.enabled !== false,
            cooldown: Number.isNaN(cooldown) ? 10 : Math.max(0, Math.min(3600, cooldown)),
            messageType: newCommand.messageType || 'announcement',
            color: newCommand.color || 'primary',
            accessLevel,
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

        // Санитизация и лимиты для обновляемых полей
        const sanitized: Partial<CustomCommand> = { ...updatedCommand };
        if (updatedCommand.trigger !== undefined) {
            const t = sanitizeString(updatedCommand.trigger, MAX_TRIGGER_LENGTH);
            if (!t) return res.status(400).json({ error: 'Триггер не должен быть пустым' });
            sanitized.trigger = t;
        }
        if (updatedCommand.response !== undefined) {
            sanitized.response = sanitizeString(updatedCommand.response, MAX_RESPONSE_LENGTH) || existing.response;
        }
        if (updatedCommand.description !== undefined) {
            sanitized.description = sanitizeString(updatedCommand.description, MAX_DESCRIPTION_LENGTH);
        }
        if (Array.isArray(updatedCommand.aliases) && updatedCommand.aliases.length > MAX_ALIASES) {
            return res.status(400).json({ error: `Максимум ${MAX_ALIASES} алиасов` });
        }
        if (updatedCommand.aliases !== undefined) {
            sanitized.aliases = updatedCommand.aliases.slice(0, MAX_ALIASES).map((a) => sanitizeString(a, MAX_TRIGGER_LENGTH)).filter(Boolean);
        }
        if (updatedCommand.cooldown !== undefined) {
            const cd = Number(updatedCommand.cooldown);
            if (!Number.isNaN(cd) && (cd < 0 || cd > 3600)) {
                return res.status(400).json({ error: 'Кулдаун должен быть от 0 до 3600 сек' });
            }
            sanitized.cooldown = Number.isNaN(cd) ? existing.cooldown : Math.max(0, Math.min(3600, cd));
        }
        if (updatedCommand.accessLevel !== undefined) {
            const al = updatedCommand.accessLevel;
            if (al !== 'everyone' && al !== 'moderators') {
                return res.status(400).json({ error: 'accessLevel должен быть "everyone" или "moderators"' });
            }
            sanitized.accessLevel = al;
        }

        // Если меняется trigger, проверяем на дубликаты
        if (sanitized.trigger && sanitized.trigger !== existing.trigger) {
            const existingTrigger = await queryOne<{ id: string }>(
                `SELECT id FROM custom_commands
                 WHERE id <> $1 AND (
                   LOWER(trigger) = LOWER($2)
                   OR EXISTS (
                     SELECT 1 FROM unnest(aliases) a WHERE LOWER(a) = LOWER($2)
                   )
                 )`,
                [id, sanitized.trigger],
            );

            if (existingTrigger) {
                return res.status(400).json({
                    error: `Триггер "${sanitized.trigger}" уже используется командой "${existingTrigger.id}"`,
                });
            }
        }

        const merged = await updateCommandInDb(id, sanitized);
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
        const accessLevel = newCounter.accessLevel === 'moderators' ? 'moderators' : 'everyone';

        const toSave: Counter = {
            ...newCounter,
            aliases: newCounter.aliases || [],
            enabled: newCounter.enabled !== false,
            value: newCounter.value || 0,
            accessLevel,
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

        if (updatedCounter.accessLevel !== undefined) {
            const al = updatedCounter.accessLevel;
            if (al !== 'everyone' && al !== 'moderators') {
                return res.status(400).json({ error: 'accessLevel должен быть "everyone" или "moderators"' });
            }
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

// === API для журнала событий (по аналогии с Nightbot) ===

type JournalRow = { id: number; created_at: Date; username: string; message: string; event_type: string };

app.get('/api/journal', async (req: Request, res: Response) => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(10, parseInt(req.query.limit as string) || 25));
        const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 200) : '';
        const eventType = typeof req.query.type === 'string' ? req.query.type.trim().toLowerCase() : '';
        const days = Math.min(30, Math.max(1, parseInt(req.query.days as string) || 7));
        const offset = (page - 1) * limit;

        const validTypes = ['message', 'command', 'system'];
        const typeFilter = eventType && validTypes.includes(eventType) ? eventType : null;

        let whereClause = `WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`;
        const params: (string | number)[] = [days];
        let paramIndex = 2;

        if (typeFilter) {
            whereClause += ` AND event_type = $${paramIndex++}`;
            params.push(typeFilter);
        }
        if (search) {
            whereClause += ` AND (LOWER(username) LIKE $${paramIndex} OR LOWER(message) LIKE $${paramIndex})`;
            params.push(`%${search.toLowerCase()}%`);
            paramIndex++;
        }

        const countResult = await queryOne<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM event_journal ${whereClause}`,
            params,
        );
        const total = parseInt(countResult?.count || '0', 10);

        const limitParam = paramIndex;
        const offsetParam = paramIndex + 1;
        const rows = await query<JournalRow>(
            `SELECT id, created_at, username, message, event_type
             FROM event_journal
             ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${limitParam} OFFSET $${offsetParam}`,
            [...params, limit, offset],
        );

        res.json({
            items: rows.map((r) => ({
                id: r.id,
                createdAt: r.created_at,
                username: r.username,
                message: r.message,
                eventType: r.event_type,
            })),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error('❌ Ошибка загрузки журнала:', error);
        res.status(500).json({ error: 'Ошибка загрузки журнала' });
    }
});

type AdminJournalRow = { id: number; created_at: Date; admin_username: string; action: string; details: string };

app.get('/api/admin-journal', async (req: Request, res: Response) => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(10, parseInt(req.query.limit as string) || 25));
        const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 200) : '';
        const days = Math.min(30, Math.max(1, parseInt(req.query.days as string) || 7));
        const offset = (page - 1) * limit;

        let whereClause = `WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`;
        const params: (string | number)[] = [days];
        let paramIndex = 2;

        if (search) {
            whereClause += ` AND (LOWER(admin_username) LIKE $${paramIndex} OR LOWER(action) LIKE $${paramIndex} OR LOWER(details) LIKE $${paramIndex})`;
            params.push(`%${search.toLowerCase()}%`);
            paramIndex++;
        }

        const countResult = await queryOne<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM admin_action_journal ${whereClause}`,
            params,
        );
        const total = parseInt(countResult?.count || '0', 10);

        const limitParam = paramIndex;
        const offsetParam = paramIndex + 1;
        const rows = await query<AdminJournalRow>(
            `SELECT id, created_at, admin_username, action, details
             FROM admin_action_journal
             ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${limitParam} OFFSET $${offsetParam}`,
            [...params, limit, offset],
        );

        res.json({
            items: rows.map((r) => ({
                id: r.id,
                createdAt: r.created_at,
                username: r.admin_username,
                message: r.details ? `${r.action} — ${r.details}` : r.action,
                eventType: 'system',
            })),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error('❌ Ошибка загрузки журнала админов:', error);
        res.status(500).json({ error: 'Ошибка загрузки журнала админов' });
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
        const safeText = sanitizeString(text, MAX_TEXT_LENGTH);
        if (!safeText) return res.status(400).json({ error: 'Поле text не должно быть пустым' });
        const maxOrder = await queryOne<{ max: number | null }>(
            'SELECT MAX(sort_order) AS max FROM party_items',
        );
        const sortOrder = (maxOrder?.max ?? -1) + 1;
        const result = await query<PartyItemRow>(
            'INSERT INTO party_items (text, sort_order) VALUES ($1, $2) RETURNING id, text, sort_order',
            [safeText, sortOrder],
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
        const safeText = sanitizeString(text, MAX_TEXT_LENGTH);
        if (!safeText) return res.status(400).json({ error: 'Поле text не должно быть пустым' });
        const result = await query<PartyItemRow>(
            'UPDATE party_items SET text = $2 WHERE id = $1 RETURNING id, text, sort_order',
            [id, safeText],
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

app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
        if (!JWT_SECRET && isProd) {
            res.status(503).json({ success: false, error: 'JWT_SECRET не настроен на сервере' });
            return;
        }
        const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
        if (!checkLoginRateLimit(ip)) {
            res.status(429).json({ success: false, error: 'Слишком много попыток входа. Повторите через минуту.' });
            return;
        }
        const { username, password } = req.body;
        if (typeof username !== 'string' || typeof password !== 'string') {
            recordLoginAttempt(ip);
            res.status(400).json({ success: false, error: 'Укажите логин и пароль' });
            return;
        }
        const name = username.trim().toLowerCase();
        if (!name || name.length > 80) {
            recordLoginAttempt(ip);
            res.status(400).json({ success: false, error: 'Некорректный логин' });
            return;
        }
        const row = await queryOne<{ id: number; username: string; password_hash: string }>(
            'SELECT id, username, password_hash FROM admin_users WHERE LOWER(username) = $1',
            [name]
        );
        if (!row || !(await bcrypt.compare(password, row.password_hash))) {
            recordLoginAttempt(ip);
            res.status(401).json({ success: false, error: 'Неверный логин или пароль' });
            return;
        }
        const token = jwt.sign(
            { userId: row.id, username: row.username } as JwtPayload,
            JWT_SECRET!,
            { expiresIn: JWT_EXPIRES_IN }
        );
        res.json({ success: true, token });
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
        const overlaySyncEnabled = getDuelOverlaySyncEnabledCallback ? getDuelOverlaySyncEnabledCallback() : false;
        res.json({ enabled, skipCooldown, overlaySyncEnabled });
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

// Вкл/выкл синхронизации сообщений дуэли с оверлеем
app.post('/api/admin/duels/set-overlay-sync', (req: Request, res: Response) => {
    try {
        const enabled = Boolean(req.body?.enabled);
        if (setDuelOverlaySyncEnabledCallback) setDuelOverlaySyncEnabledCallback(enabled);
        res.json({ success: true, overlaySyncEnabled: enabled });
    } catch (error) {
        console.error('❌ Ошибка установки режима синхронизации оверлея:', error);
        res.status(500).json({ error: 'Ошибка установки режима синхронизации оверлея' });
    }
});

// Настройки модерации чата (анти-спам)
type ChatModerationRow = {
    moderation_enabled: boolean;
    check_symbols: boolean;
    check_letters: boolean;
    check_links: boolean;
    max_message_length: number;
    max_letters_digits: number;
    timeout_minutes: number;
};

const defaultModerationConfig = () => ({
    moderationEnabled: true,
    checkSymbols: true,
    checkLetters: true,
    checkLinks: false,
    maxMessageLength: 300,
    maxLettersDigits: 300,
    timeoutMinutes: 10,
});

app.get('/api/admin/chat-moderation/config', async (_req: Request, res: Response) => {
    try {
        const row = await queryOne<ChatModerationRow>(
            'SELECT moderation_enabled, check_symbols, check_links, check_letters, max_message_length, max_letters_digits, timeout_minutes FROM chat_moderation_config WHERE id = 1'
        );
        if (!row) {
            res.json(defaultModerationConfig());
            return;
        }
        res.json({
            moderationEnabled: row.moderation_enabled ?? true,
            checkSymbols: row.check_symbols ?? true,
            checkLetters: row.check_letters ?? true,
            checkLinks: row.check_links ?? false,
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
        const checkLinks =
            req.body?.checkLinks != null ? Boolean(req.body.checkLinks) : undefined;
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
        if (checkLinks != null) {
            updates.push(`check_links = $${i++}`);
            params.push(checkLinks);
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
                'SELECT moderation_enabled, check_symbols, check_letters, check_links, max_message_length, max_letters_digits, timeout_minutes FROM chat_moderation_config WHERE id = 1'
            );
            const out = row
                ? {
                      moderationEnabled: row.moderation_enabled ?? true,
                      checkSymbols: row.check_symbols ?? true,
                      checkLetters: row.check_letters ?? true,
                      checkLinks: row.check_links ?? false,
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
            'SELECT moderation_enabled, check_symbols, check_letters, check_links, max_message_length, max_letters_digits, timeout_minutes FROM chat_moderation_config WHERE id = 1'
        );
        const config = row
            ? {
                  moderationEnabled: row.moderation_enabled ?? true,
                  checkSymbols: row.check_symbols ?? true,
                  checkLetters: row.check_letters ?? true,
                  checkLinks: row.check_links ?? false,
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

// Whitelist разрешённых ссылок (бот пропускает эти ссылки при фильтрации)
app.get('/api/admin/link-whitelist', async (_req: Request, res: Response) => {
    try {
        const rows = (await query('SELECT pattern FROM link_whitelist ORDER BY id')) as { pattern: string }[];
        const patterns = (rows ?? []).map((r) => r.pattern ?? '').filter(Boolean);
        res.json({ patterns });
    } catch (error) {
        console.error('❌ Ошибка получения whitelist ссылок:', error);
        res.status(500).json({ error: 'Ошибка получения whitelist ссылок' });
    }
});

function normalizeLinkPattern(url: string): string {
    return url
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/\/+$/, '')
        .replace(/[.,;:!?)\]}>]+$/, '');
}

app.post('/api/admin/link-whitelist', async (req: Request, res: Response) => {
    try {
        const raw = Array.isArray(req.body?.patterns) ? (req.body.patterns as string[]) : [];
        const patterns = [
            ...new Set(
                raw.flatMap((p) =>
                    String(p ?? '')
                        .split(/[\n,]/)
                        .map((s) => normalizeLinkPattern(s))
                        .filter(Boolean)
                )
            ),
        ];
        await query('DELETE FROM link_whitelist');
        for (const pattern of patterns) {
            await query('INSERT INTO link_whitelist (pattern) VALUES ($1)', [pattern]);
        }
        if (onChatModerationConfigUpdatedCallback) onChatModerationConfigUpdatedCallback();
        res.json({ patterns });
    } catch (error) {
        console.error('❌ Ошибка сохранения whitelist ссылок:', error);
        res.status(500).json({ error: 'Ошибка сохранения whitelist ссылок' });
    }
});

// Настройки дуэлей (таймаут, очки, штраф за промах, рейд-буст)
type DuelConfigRow = {
    timeout_minutes: number;
    win_points: number;
    loss_points: number;
    miss_penalty: number;
    raid_duel_boost_enabled: boolean;
    raid_duel_boost_win_percent: number;
    raid_duel_boost_duration_minutes: number;
    raid_duel_boost_min_viewers: number;
};

app.get('/api/admin/duels/config', async (req: Request, res: Response) => {
    try {
        const row = await queryOne<DuelConfigRow>(
            'SELECT timeout_minutes, win_points, loss_points, miss_penalty, raid_duel_boost_enabled, raid_duel_boost_win_percent, raid_duel_boost_duration_minutes, raid_duel_boost_min_viewers FROM duel_config WHERE id = 1'
        );
        if (!row) {
            res.json({
                timeoutMinutes: 5,
                winPoints: 25,
                lossPoints: 25,
                missPenalty: 5,
                raidBoostEnabled: false,
                raidBoostWinPercent: 70,
                raidBoostDurationMinutes: 10,
                raidBoostMinViewers: 5,
            });
            return;
        }
        res.json({
            timeoutMinutes: row.timeout_minutes,
            winPoints: row.win_points,
            lossPoints: row.loss_points,
            missPenalty: row.miss_penalty ?? 5,
            raidBoostEnabled: row.raid_duel_boost_enabled ?? false,
            raidBoostWinPercent: row.raid_duel_boost_win_percent ?? 70,
            raidBoostDurationMinutes: row.raid_duel_boost_duration_minutes ?? 10,
            raidBoostMinViewers: row.raid_duel_boost_min_viewers ?? 5,
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
        const raidBoostEnabled = req.body?.raidBoostEnabled != null ? Boolean(req.body.raidBoostEnabled) : undefined;
        const raidBoostWinPercent = req.body?.raidBoostWinPercent != null ? Number(req.body.raidBoostWinPercent) : undefined;
        const raidBoostDurationMinutes = req.body?.raidBoostDurationMinutes != null ? Number(req.body.raidBoostDurationMinutes) : undefined;
        const raidBoostMinViewers = req.body?.raidBoostMinViewers != null ? Number(req.body.raidBoostMinViewers) : undefined;
        if (
            (timeoutMinutes != null && (Number.isNaN(timeoutMinutes) || timeoutMinutes < 0)) ||
            (winPoints != null && (Number.isNaN(winPoints) || winPoints < 0)) ||
            (lossPoints != null && (Number.isNaN(lossPoints) || lossPoints < 0)) ||
            (missPenalty != null && (Number.isNaN(missPenalty) || missPenalty < 0))
        ) {
            res.status(400).json({ error: 'Значения должны быть неотрицательными числами' });
            return;
        }
        if (
            (raidBoostWinPercent != null &&
                (Number.isNaN(raidBoostWinPercent) || raidBoostWinPercent < 1 || raidBoostWinPercent > 99)) ||
            (raidBoostDurationMinutes != null &&
                (Number.isNaN(raidBoostDurationMinutes) || raidBoostDurationMinutes < 1 || raidBoostDurationMinutes > 240)) ||
            (raidBoostMinViewers != null &&
                (Number.isNaN(raidBoostMinViewers) || raidBoostMinViewers < 0 || raidBoostMinViewers > 100000))
        ) {
            res.status(400).json({
                error: 'Рейд-буст: шанс 1–99%, длительность 1–240 мин, мин. зрителей 0–100000',
            });
            return;
        }
        const updates: string[] = [];
        const params: (number | boolean)[] = [];
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
        if (raidBoostEnabled != null) {
            updates.push(`raid_duel_boost_enabled = $${i++}`);
            params.push(raidBoostEnabled);
        }
        if (raidBoostWinPercent != null) {
            updates.push(`raid_duel_boost_win_percent = $${i++}`);
            params.push(raidBoostWinPercent);
        }
        if (raidBoostDurationMinutes != null) {
            updates.push(`raid_duel_boost_duration_minutes = $${i++}`);
            params.push(raidBoostDurationMinutes);
        }
        if (raidBoostMinViewers != null) {
            updates.push(`raid_duel_boost_min_viewers = $${i++}`);
            params.push(raidBoostMinViewers);
        }
        if (updates.length === 0) {
            const row = await queryOne<DuelConfigRow>(
                'SELECT timeout_minutes, win_points, loss_points, miss_penalty, raid_duel_boost_enabled, raid_duel_boost_win_percent, raid_duel_boost_duration_minutes, raid_duel_boost_min_viewers FROM duel_config WHERE id = 1'
            );
            const out = row
                ? {
                      timeoutMinutes: row.timeout_minutes,
                      winPoints: row.win_points,
                      lossPoints: row.loss_points,
                      missPenalty: row.miss_penalty ?? 5,
                      raidBoostEnabled: row.raid_duel_boost_enabled ?? false,
                      raidBoostWinPercent: row.raid_duel_boost_win_percent ?? 70,
                      raidBoostDurationMinutes: row.raid_duel_boost_duration_minutes ?? 10,
                      raidBoostMinViewers: row.raid_duel_boost_min_viewers ?? 5,
                  }
                : {
                      timeoutMinutes: 5,
                      winPoints: 25,
                      lossPoints: 25,
                      missPenalty: 5,
                      raidBoostEnabled: false,
                      raidBoostWinPercent: 70,
                      raidBoostDurationMinutes: 10,
                      raidBoostMinViewers: 5,
                  };
            res.json(out);
            return;
        }
        await query(
            `UPDATE duel_config SET ${updates.join(', ')} WHERE id = 1`,
            params as unknown[]
        );
        const row = await queryOne<DuelConfigRow>(
            'SELECT timeout_minutes, win_points, loss_points, miss_penalty, raid_duel_boost_enabled, raid_duel_boost_win_percent, raid_duel_boost_duration_minutes, raid_duel_boost_min_viewers FROM duel_config WHERE id = 1'
        );
        const config = row
            ? {
                  timeoutMinutes: row.timeout_minutes,
                  winPoints: row.win_points,
                  lossPoints: row.loss_points,
                  missPenalty: row.miss_penalty ?? 5,
                  raidBoostEnabled: row.raid_duel_boost_enabled ?? false,
                  raidBoostWinPercent: row.raid_duel_boost_win_percent ?? 70,
                  raidBoostDurationMinutes: row.raid_duel_boost_duration_minutes ?? 10,
                  raidBoostMinViewers: row.raid_duel_boost_min_viewers ?? 5,
              }
            : {
                  timeoutMinutes: 5,
                  winPoints: 25,
                  lossPoints: 25,
                  missPenalty: 5,
                  raidBoostEnabled: false,
                  raidBoostWinPercent: 70,
                  raidBoostDurationMinutes: 10,
                  raidBoostMinViewers: 5,
              };
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
let getDuelOverlaySyncEnabledCallback: (() => boolean) | null = null;
let setDuelOverlaySyncEnabledCallback: ((enabled: boolean) => void) | null = null;
let onDuelConfigUpdatedCallback:
    | ((config: {
          timeoutMinutes: number;
          winPoints: number;
          lossPoints: number;
          missPenalty: number;
          raidBoostEnabled: boolean;
          raidBoostWinPercent: number;
          raidBoostDurationMinutes: number;
          raidBoostMinViewers: number;
      }) => void)
    | null = null;
let onDuelDailyConfigUpdatedCallback: ((config: { dailyGamesCount: number; dailyRewardPoints: number; streakWinsCount: number; streakRewardPoints: number }) => void) | null = null;
let onLinksConfigUpdatedCallback: ((config: LinksConfig) => void) | null = null;
let onRaidConfigUpdatedCallback: ((config: RaidConfig) => void) | null = null;
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

export function setOnRaidConfigUpdatedCallback(callback: (config: RaidConfig) => void) {
    onRaidConfigUpdatedCallback = callback;
}

export async function getRaidMessageFromDb(): Promise<string> {
    const config = await getRaidFromDb();
    return config.raidMessage;
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

export function setGetDuelOverlaySyncEnabledCallback(callback: () => boolean) {
    getDuelOverlaySyncEnabledCallback = callback;
}

export function setSetDuelOverlaySyncEnabledCallback(callback: (enabled: boolean) => void) {
    setDuelOverlaySyncEnabledCallback = callback;
}

export function setOnDuelConfigUpdatedCallback(callback: (config: {
    timeoutMinutes: number;
    winPoints: number;
    lossPoints: number;
    missPenalty: number;
    raidBoostEnabled: boolean;
    raidBoostWinPercent: number;
    raidBoostDurationMinutes: number;
    raidBoostMinViewers: number;
}) => void) {
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

// Запуск сервера (HTTP + WebSocket на том же порту). При EADDRINUSE пробует порты 3001, 3002...
export function startWebServer(): Promise<void> {
    return new Promise((resolve, reject) => {
        function attempt(port: number): void {
            const server = http.createServer(app);
            const wsServer = new WebSocket.Server({ server, path: WS_PATH });
            const clients = new Set<WebSocket>();

            wsServer.on('connection', (ws: WebSocket) => {
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

            const onListen = (): void => {
                wss = wsServer;
                console.log(`🌐 Веб-интерфейс доступен: http://localhost:${port}`);
                console.log(`🔌 WebSocket для админки: ws://localhost:${port}${WS_PATH}`);
                if (port !== PORT) {
                    console.warn(`💡 Порт ${PORT} был занят. При dev:all проверьте, что target в vite.config.ts указывает на localhost:${port}`);
                }
                resolve();
            };

            server.once('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE' && port < 3010) {
                    console.warn(`⚠️ Порт ${port} занят, пробуем ${port + 1}...`);
                    server.close();
                    attempt(port + 1);
                } else {
                    reject(err);
                }
            });

            server.listen(port, onListen);
        }

        attempt(PORT);
    });
}

// Если запускается напрямую
if (require.main === module) {
    startWebServer().catch(console.error);
}
