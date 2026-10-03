import { describe, it, expect } from 'vitest';
import { capPermissionMode, permissionModeRank } from './permissionModeCeiling';

describe('capPermissionMode', () => {
    it.each([
        ['yolo', 'default', 'default', true],
        ['bypassPermissions', 'default', 'default', true],
        ['acceptEdits', 'auto', 'auto', true],
        ['safe-yolo', 'read-only', 'read-only', true],
        ['default', 'bypassPermissions', 'default', false],
        ['read-only', 'yolo', 'read-only', false],
        ['acceptEdits', 'acceptEdits', 'acceptEdits', false],
        ['turbo', 'yolo', 'yolo', true],
        ['acceptEdits', undefined, 'default', true],
        ['plan', undefined, 'plan', false],
    ])('requested %s with ceiling %s → %s (capped=%s)', (requested, ceiling, mode, capped) => {
        expect(capPermissionMode(requested, ceiling)).toEqual({ mode, capped });
    });
    it('ranks known modes and not unknown ones', () => {
        expect(permissionModeRank('plan')).toBe(0);
        expect(permissionModeRank('yolo')).toBe(3);
        expect(permissionModeRank('turbo')).toBeUndefined();
    });
});
