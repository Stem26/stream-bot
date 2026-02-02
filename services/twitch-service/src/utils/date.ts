import { PlayerData } from '../storage/players';

export function getMoscowDate(): string {
  const now = new Date();
  const moscowTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
  const year = moscowTime.getUTCFullYear();
  const month = String(moscowTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(moscowTime.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function canPlayToday(player: PlayerData): boolean {
  const today = getMoscowDate();
  if (!player.lastUsedDate) {
    return true;
  }

  return player.lastUsedDate !== today;
}

export function canUseHornyToday(player: PlayerData): boolean {
  const today = getMoscowDate();
  if (!player.lastHornyDate) {
    return true;
  }

  return player.lastHornyDate !== today;
}

export function canUseFurryToday(player: PlayerData): boolean {
  const today = getMoscowDate();
  if (!player.lastFurryDate) {
    return true;
  }

  return player.lastFurryDate !== today;
}

export function canUseFutureToday(player: PlayerData): boolean {
  const today = getMoscowDate();
  if (!player.lastFutureDate) {
    return true;
  }

  return player.lastFutureDate !== today;
}


