import { ALLOWED_ADMINS } from '../config/env';

export function canUsePost(userId: number): boolean {
  if (ALLOWED_ADMINS.length === 0) {
    return false;
  }

  return ALLOWED_ADMINS.includes(userId);
}