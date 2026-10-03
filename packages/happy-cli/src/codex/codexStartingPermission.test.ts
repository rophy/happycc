import { describe, expect, it } from 'vitest';
import { codexStartingPermissionMetadata } from './codexStartingPermission';

describe('codexStartingPermissionMetadata', () => {
    it.each([
        ['auto', false],
        ['read-only', false],
        ['safe-yolo', false],
        ['yolo', true],
    ] as const)('publishes %s as the ceiling', (mode, skips) => {
        expect(codexStartingPermissionMetadata(mode)).toEqual({ dangerouslySkipPermissions: skips, permissionModeCeiling: mode });
    });
});
