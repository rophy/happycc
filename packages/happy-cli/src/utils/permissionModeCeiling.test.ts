import { describe, it, expect } from 'vitest';
import { capPermissionMode, permissionModeCapNotice, permissionModeRank } from './permissionModeCeiling';

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
        expect(capPermissionMode(requested, ceiling)).toMatchObject({ mode, capped });
    });
    it('ranks known modes and not unknown ones', () => {
        expect(permissionModeRank('plan')).toBe(0);
        expect(permissionModeRank('yolo')).toBe(3);
        expect(permissionModeRank('turbo')).toBeUndefined();
    });
    it('distinguishes why a request was capped', () => {
        expect(capPermissionMode('yolo', 'default')).toMatchObject({ capped: true, reason: 'above-ceiling' });
        expect(capPermissionMode('Code', 'default')).toMatchObject({ capped: true, reason: 'unranked' });
        expect(capPermissionMode('plan', 'default')).toEqual({ mode: 'plan', capped: false });
    });
    it('words the notice by reason', () => {
        expect(permissionModeCapNotice('yolo', capPermissionMode('yolo', 'default')))
            .toBe('Ignored a request from the app to raise the permission mode to yolo.');
        expect(permissionModeCapNotice('Code', capPermissionMode('Code', 'default')))
            .toBe("Ignored a request from the app to change the permission mode to Code: this agent's modes cannot be changed from the app.");
    });
});
