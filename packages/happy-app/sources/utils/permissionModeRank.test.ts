import { describe, expect, it } from 'vitest';
import { capComposerPermissionModes, filterModesAtOrBelow, isPermissionModeAllowed, permissionModeRank, resolveDisplayedPermissionMode, sessionStartingPermissionMode, usesClaudeModeMapping } from './permissionModeRank';

describe('permissionModeRank', () => {
    it.each([
        ['plan', 0], ['read-only', 0],
        ['default', 1],
        ['auto', 2],
        ['acceptEdits', 3], ['safe-yolo', 3],
        ['bypassPermissions', 4], ['yolo', 4],
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
    it('uses the ceiling happycc publishes', () => {
        expect(sessionStartingPermissionMode({ permissionModeCeiling: 'acceptEdits' })).toBe('acceptEdits');
        expect(sessionStartingPermissionMode({ permissionModeCeiling: 'plan', dangerouslySkipPermissions: false })).toBe('plan');
        expect(sessionStartingPermissionMode({ permissionModeCeiling: 'default', dangerouslySkipPermissions: true })).toBe('default');
    });

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

    it('treats an unranked starting mode as default', () => {
        expect(filterModesAtOrBelow(claude, 'turbo').map((m) => m.key)).toEqual(['default', 'plan']);
    });
});

describe('the picker for a session with a published ceiling', () => {
    const claude = [{ key: 'default' }, { key: 'acceptEdits' }, { key: 'plan' }, { key: 'bypassPermissions' }];
    const offered = (ceiling: string) => filterModesAtOrBelow(claude, sessionStartingPermissionMode({ permissionModeCeiling: ceiling })).map((m) => m.key);

    it('offers acceptEdits, default and plan for an acceptEdits start', () => {
        expect(offered('acceptEdits')).toEqual(['default', 'acceptEdits', 'plan']);
    });

    it('offers only plan for a plan start', () => {
        expect(offered('plan')).toEqual(['plan']);
    });

    it('falls back to the heuristic without one (older CLIs)', () => {
        expect(filterModesAtOrBelow(claude, sessionStartingPermissionMode({})).map((m) => m.key)).toEqual(['default', 'plan']);
        expect(filterModesAtOrBelow(claude, sessionStartingPermissionMode({ dangerouslySkipPermissions: true }))).toEqual(claude);
    });
});

describe('isPermissionModeAllowed', () => {
    it('allows ranked modes at or below the ceiling only', () => {
        expect(isPermissionModeAllowed('plan', 'default')).toBe(true);
        expect(isPermissionModeAllowed('acceptEdits', 'default')).toBe(false);
        expect(isPermissionModeAllowed('yolo', 'yolo')).toBe(true);
        expect(isPermissionModeAllowed('turbo', 'yolo')).toBe(false);
    });

    it('ranks auto above default', () => {
        expect(isPermissionModeAllowed('auto', 'default')).toBe(false);
        expect(isPermissionModeAllowed('default', 'auto')).toBe(true);
        expect(isPermissionModeAllowed('auto', 'acceptEdits')).toBe(true);
    });

    it('compares Claude modes as the session applies them', () => {
        // read-only runs as default on Claude: not below a plan start
        expect(isPermissionModeAllowed('read-only', 'plan')).toBe(true);
        expect(isPermissionModeAllowed('read-only', 'plan', true)).toBe(false);
        expect(isPermissionModeAllowed('safe-yolo', 'default', true)).toBe(true);
        expect(isPermissionModeAllowed('bypassPermissions', 'yolo', true)).toBe(true);
        expect(isPermissionModeAllowed('plan', 'plan', true)).toBe(true);
    });
});

describe('usesClaudeModeMapping', () => {
    it('is true for Claude and for sessions without a flavor', () => {
        expect(usesClaudeModeMapping({ flavor: 'claude' })).toBe(true);
        expect(usesClaudeModeMapping({})).toBe(true);
        expect(usesClaudeModeMapping(null)).toBe(true);
        expect(usesClaudeModeMapping({ flavor: 'codex' })).toBe(false);
        expect(usesClaudeModeMapping({ flavor: 'gemini' })).toBe(false);
    });
});

describe('resolveDisplayedPermissionMode', () => {
    const modes = [{ key: 'default' }, { key: 'plan' }];
    it('shows the current mode when it is on offer', () => {
        expect(resolveDisplayedPermissionMode({ key: 'plan' }, modes, 'default')).toEqual({ key: 'plan' });
    });
    it('shows the ceiling for a pick above it', () => {
        expect(resolveDisplayedPermissionMode({ key: 'bypassPermissions' }, modes, 'default')).toEqual({ key: 'default' });
        expect(resolveDisplayedPermissionMode(null, modes, 'default')).toEqual({ key: 'default' });
    });
    it('shows nothing when the ceiling itself is not on offer', () => {
        expect(resolveDisplayedPermissionMode({ key: 'yolo' }, [{ key: 'read-only' }], 'plan')).toBeNull();
    });
});

describe('capComposerPermissionModes', () => {
    const claude = [{ key: 'default' }, { key: 'acceptEdits' }, { key: 'plan' }, { key: 'bypassPermissions' }];

    it('offers modes up to the ceiling and shows a stale higher pick as the ceiling', () => {
        const result = capComposerPermissionModes({
            modes: claude,
            current: { key: 'bypassPermissions' },
            metadata: { permissionModeCeiling: 'acceptEdits' },
            isRig: false,
        });
        expect(result.availableModes.map((m) => m.key)).toEqual(['default', 'acceptEdits', 'plan']);
        expect(result.permissionMode).toEqual({ key: 'acceptEdits' });
    });

    it('shows a Claude yolo start as bypass', () => {
        const result = capComposerPermissionModes({
            modes: claude, current: null, metadata: { flavor: 'claude', permissionModeCeiling: 'yolo' }, isRig: false,
        });
        expect(result.availableModes).toEqual(claude);
        expect(result.permissionMode).toEqual({ key: 'bypassPermissions' });
    });

    it('offers a Codex auto start default and read-only, not safe-yolo', () => {
        const codex = [{ key: 'auto' }, { key: 'default' }, { key: 'read-only' }, { key: 'safe-yolo' }, { key: 'yolo' }];
        const result = capComposerPermissionModes({
            modes: codex, current: null, metadata: { flavor: 'codex', permissionModeCeiling: 'auto' }, isRig: false,
        });
        expect(result.availableModes.map((m) => m.key)).toEqual(['auto', 'default', 'read-only']);
    });

    it('leaves a Rig session catalog alone', () => {
        const rig = [{ key: 'ask' }, { key: 'full' }];
        expect(capComposerPermissionModes({ modes: rig, current: rig[1], metadata: {}, isRig: true }))
            .toEqual({ availableModes: rig, permissionMode: rig[1] });
    });
});
