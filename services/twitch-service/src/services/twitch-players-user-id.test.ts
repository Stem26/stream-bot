import { describe, it, expect } from 'vitest';
import { normalizeTwitchUserId } from './twitch-players-user-id';

describe('normalizeTwitchUserId', () => {
    it('принимает числовую строку', () => {
        expect(normalizeTwitchUserId('897528838')).toBe('897528838');
    });

    it('отклоняет пустое и нецифровое', () => {
        expect(normalizeTwitchUserId('')).toBeNull();
        expect(normalizeTwitchUserId('abc')).toBeNull();
        expect(normalizeTwitchUserId(null)).toBeNull();
    });
});
