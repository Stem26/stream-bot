import { loadTwitchPlayers, saveTwitchPlayers, TwitchPlayerData } from '../storage/twitch-players';

type DuelQueueEntry = {
  username: string;
  displayName: string;
  joinedAt: number;
};

const duelQueueByChannel = new Map<string, DuelQueueEntry>();
const DEFAULT_POINTS = 1000;
const DUEL_WIN_POINTS = 25;
const DUEL_TIMEOUT_MS = 5 * 60 * 1000;
const DUEL_COOLDOWN_MS = 60 * 1000;

function ensurePlayer(players: Map<string, TwitchPlayerData>, twitchUsername: string): TwitchPlayerData {
  const normalized = twitchUsername.toLowerCase();
  let player = players.get(normalized);

  if (!player) {
    player = {
      twitchUsername,
      size: 0,
      lastUsed: 0,
      lastUsedDate: undefined,
      points: DEFAULT_POINTS
    };
    players.set(normalized, player);
    return player;
  }

  if (player.points === undefined) {
    player.points = DEFAULT_POINTS;
  }
  if (player.size === undefined) {
    player.size = 0;
  }
  if (player.lastUsed === undefined) {
    player.lastUsed = 0;
  }
  player.twitchUsername = twitchUsername;
  players.set(normalized, player);

  return player;
}

export function processTwitchDuelCommand(
    twitchUsername: string,
    channel: string
): { response: string; loser?: string } {
  const players = loadTwitchPlayers();
  const now = Date.now();
  const normalized = twitchUsername.toLowerCase();
  const player = ensurePlayer(players, twitchUsername);

  if (player.lastDuelUsed && now - player.lastDuelUsed < DUEL_COOLDOWN_MS) {
    const secondsLeft = Math.ceil((DUEL_COOLDOWN_MS - (now - player.lastDuelUsed)) / 1000);
    return {
      response: `@${twitchUsername}, КД на дуэль ещё ${secondsLeft} сек.`
    };
  }

  if (player.duelTimeoutUntil && now < player.duelTimeoutUntil) {
    const minutesLeft = Math.ceil((player.duelTimeoutUntil - now) / 60000);
    return {
      response: `@${twitchUsername}, ты в таймауте ещё ${minutesLeft} мин.`
    };
  }

  const waiting = duelQueueByChannel.get(channel);

  if (!waiting) {
    duelQueueByChannel.set(channel, { username: normalized, displayName: twitchUsername, joinedAt: now });
    saveTwitchPlayers(players);
    return {
      response: `@${twitchUsername}, ты встал в очередь на дуэль. Ждём соперника!`
    };
  }

  if (waiting.username === normalized) {
    return {
      response: `@${twitchUsername}, ты уже в очереди на дуэль. Ждём соперника!`
    };
  }

  const opponentPlayer = ensurePlayer(players, waiting.displayName);

  const winnerIsCurrent = Math.random() < 0.5;
  const winner = winnerIsCurrent ? twitchUsername : waiting.displayName;
  const loser = winnerIsCurrent ? waiting.displayName : twitchUsername;

  if (winnerIsCurrent) {
    player.points = (player.points ?? DEFAULT_POINTS) + DUEL_WIN_POINTS;
    opponentPlayer.points = (opponentPlayer.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS;
    opponentPlayer.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;
  } else {
    opponentPlayer.points = (opponentPlayer.points ?? DEFAULT_POINTS) + DUEL_WIN_POINTS;
    player.points = (player.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS;
    player.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;
  }

  player.lastDuelUsed = now;
  opponentPlayer.lastDuelUsed = now;
  duelQueueByChannel.delete(channel);
  saveTwitchPlayers(players);

  return {
    response: `@${waiting.displayName} и @${twitchUsername} сошлись в дуэли! Победитель @${winner} (+${DUEL_WIN_POINTS}), проигравший @${loser} (-${DUEL_WIN_POINTS}) и в таймаут на 5 минут.`,
    loser
  };
}
