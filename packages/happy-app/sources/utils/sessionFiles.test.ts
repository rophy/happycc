import { describe, expect, it } from 'vitest';
import { canEditSessionFiles, isSidebarPanelAvailable } from './sessionFiles';

describe('session file features', () => {
    it('drops the All files panel in a workstation-only build', () => {
        expect(isSidebarPanelAvailable('allFiles', true)).toBe(false);
        expect(isSidebarPanelAvailable('changes', true)).toBe(true);
        expect(isSidebarPanelAvailable('sideChat', true)).toBe(true);
        expect(isSidebarPanelAvailable('allFiles', false)).toBe(true);
    });

    it('never offers editing in a workstation-only build', () => {
        expect(canEditSessionFiles(true, true)).toBe(false);
        expect(canEditSessionFiles(true, false)).toBe(true);
        expect(canEditSessionFiles(false, false)).toBe(false);
    });
});
