import type { PermissionMode } from '@/api/types';

/**
 * What a Codex session publishes about its starting mode. The starting mode is
 * also the ceiling the app may never raise the session above (remoteModeState).
 */
export function codexStartingPermissionMetadata(initialPermissionMode: PermissionMode): {
    dangerouslySkipPermissions: boolean;
    permissionModeCeiling: PermissionMode;
} {
    return {
        dangerouslySkipPermissions: initialPermissionMode === 'yolo' || initialPermissionMode === 'bypassPermissions',
        permissionModeCeiling: initialPermissionMode,
    };
}
