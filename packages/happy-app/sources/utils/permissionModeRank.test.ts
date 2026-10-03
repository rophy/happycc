import { describe, expect, it } from 'vitest';
import { filterModesAtOrBelow, permissionModeRank, sessionStartingPermissionMode } from './permissionModeRank';

describe('permissionModeRank', () => {
    it.each([
        ['plan', 0], ['read-only', 0],
        ['default', 1], ['auto', 1],
        ['acceptEdits', 2], ['safe-yolo', 2],
        ['bypassPermissions', 3], ['yolo', 3],
    ])('ranks %s as %i', (mode, rank) => {
        expect(permissionModeRank(mode)).toBe(rank);
    });

    it('does not rank unknown modes or Object.prototype names', () => {
        expect(permissionModeRank('turbo')).toBeUndefined();
        expect(permissionModeRank('toString')).toBeUndefined();
        expect(permissionModeRank('__proto__')).toBeUndefined();
    });
});

describe('sessionStartingPermissionMode', () => {
    it('is bypass when the CLI says the session skips permissions', () => {
        expect(sessionStartingPermissionMode({ dangerouslySkipPermissions: true })).toBe('bypassPermissions');
    });

    it('is default when the metadata does not say, or says no', () => {
        expect(sessionStartingPermissionMode({ dangerouslySkipPermissions: false })).toBe('default');
        expect(sessionStartingPermissionMode({ dangerouslySkipPermissions: null })).toBe('default');
        expect(sessionStartingPermissionMode({})).toBe('default');
        expect(sessionStartingPermissionMode(null)).toBe('default');
        expect(sessionStartingPermissionMode(undefined)).toBe('default');
    });

    it('ignores the synced permission pick, which any client can write', () => {
        const picked: { dangerouslySkipPermissions?: boolean | null; permissionMode?: string } = { permissionMode: 'bypassPermissions' };
        expect(sessionStartingPermissionMode(picked)).toBe('default');
    });
});

describe('filterModesAtOrBelow', () => {
    const claude = [{ key: 'default' }, { key: 'acceptEdits' }, { key: 'plan' }, { key: 'bypassPermissions' }];
    const codex = [{ key: 'default' }, { key: 'read-only' }, { key: 'safe-yolo' }, { key: 'yolo' }];

    it('offers only modes no more permissive than the starting mode, in their order', () => {
        expect(filterModesAtOrBelow(claude, 'default').map((m) => m.key)).toEqual(['default', 'plan']);
        expect(filterModesAtOrBelow(codex, 'default').map((m) => m.key)).toEqual(['default', 'read-only']);
        expect(filterModesAtOrBelow(claude, 'acceptEdits').map((m) => m.key)).toEqual(['default', 'acceptEdits', 'plan']);
        expect(filterModesAtOrBelow(claude, 'bypassPermissions')).toEqual(claude);
        expect(filterModesAtOrBelow(codex, 'plan').map((m) => m.key)).toEqual(['read-only']);
    });

    it('drops unranked modes: the CLI ignores them from the app', () => {
        expect(filterModesAtOrBelow([{ key: 'default' }, { key: 'turbo' }], 'yolo').map((m) => m.key)).toEqual(['default']);
    });

    it('ranks an opaque code by the semantic kind published beside it, whichever is more permissive', () => {
        const rig = [
            { key: 'ask', semanticKind: 'default' },
            { key: 'auto', semanticKind: 'safe-yolo' },
            { key: 'full', semanticKind: 'yolo' },
            { key: 'custom', semanticKind: null },
        ];
        expect(filterModesAtOrBelow(rig, 'default').map((m) => m.key)).toEqual(['ask']);
        expect(filterModesAtOrBelow(rig, 'acceptEdits').map((m) => m.key)).toEqual(['ask', 'auto']);
    });

    it('treats an unranked starting mode as default', () => {
        expect(filterModesAtOrBelow(claude, 'turbo').map((m) => m.key)).toEqual(['default', 'plan']);
    });
});
