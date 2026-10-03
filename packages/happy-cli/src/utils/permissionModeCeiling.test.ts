import { describe, it, expect } from 'vitest';
import { capPermissionMode, decideAppPermissionMode, permissionModeCapNotice, permissionModeRank } from './permissionModeCeiling';
import { GEMINI_APP_PERMISSION_MODES, GEMINI_STARTING_PERMISSION_MODE } from '@/gemini/constants';
import { AGY_STARTING_PERMISSION_MODE } from '@/agy/constants';
import { isPermissionMode } from '@/claude/utils/permissionMode';

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
        ['auto', 'default', 'default', true],
        ['default', 'auto', 'default', false],
        ['auto', 'acceptEdits', 'auto', false],
    ])('requested %s with ceiling %s → %s (capped=%s)', (requested, ceiling, mode, capped) => {
        expect(capPermissionMode(requested, ceiling)).toMatchObject({ mode, capped });
    });
    it('ranks known modes and not unknown ones', () => {
        expect(permissionModeRank('plan')).toBe(0);
        expect(permissionModeRank('default')).toBe(1);
        expect(permissionModeRank('auto')).toBe(2);
        expect(permissionModeRank('acceptEdits')).toBe(3);
        expect(permissionModeRank('yolo')).toBe(4);
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

describe('the Gemini path for a mode from the app', () => {
    const decide = (mode: string) => decideAppPermissionMode(
        mode, GEMINI_STARTING_PERMISSION_MODE, (m) => GEMINI_APP_PERMISSION_MODES.includes(m),
    );

    it('starts in default', () => {
        expect(GEMINI_STARTING_PERMISSION_MODE).toBe('default');
    });
    it('refuses a raise with the notice', () => {
        expect(decide('yolo')).toEqual({ kind: 'refuse', notice: 'Ignored a request from the app to raise the permission mode to yolo.' });
        expect(decide('safe-yolo')).toMatchObject({ kind: 'refuse' });
    });
    it('applies a lower or equal mode', () => {
        expect(decide('read-only')).toEqual({ kind: 'apply', mode: 'read-only' });
        expect(decide('default')).toEqual({ kind: 'apply', mode: 'default' });
    });
    it('drops modes Gemini does not take', () => {
        expect(decide('plan')).toEqual({ kind: 'unsupported' });
        expect(decide('turbo')).toEqual({ kind: 'unsupported' });
    });
});

describe('the Agy path for a mode from the app', () => {
    const decide = (mode: string) => decideAppPermissionMode(mode, AGY_STARTING_PERMISSION_MODE, () => true);

    it('starts in default', () => {
        expect(AGY_STARTING_PERMISSION_MODE).toBe('default');
    });
    it('refuses a raise, auto included', () => {
        expect(decide('bypassPermissions')).toMatchObject({ kind: 'refuse' });
        expect(decide('acceptEdits')).toMatchObject({ kind: 'refuse' });
        expect(decide('auto')).toMatchObject({ kind: 'refuse' });
    });
    it('applies a lower or equal mode', () => {
        expect(decide('plan')).toEqual({ kind: 'apply', mode: 'plan' });
        expect(decide('default')).toEqual({ kind: 'apply', mode: 'default' });
    });
    it('refuses an unranked mode it was handed', () => {
        // runAgy drops unknown names first (normalizeRemotePermissionMode); a known
        // but unranked name would be refused as unchangeable.
        expect(isPermissionMode('turbo')).toBe(false);
        expect(decide('turbo')).toMatchObject({ kind: 'refuse' });
    });
});
