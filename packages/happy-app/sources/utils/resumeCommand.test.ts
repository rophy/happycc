import { describe, expect, it } from 'vitest';
import { buildResumeCommand, buildResumeCommandBlock } from './resumeCommand';

describe('buildResumeCommand', () => {
    it('never offers a native CLI resume command for Rig sessions', () => {
        expect(buildResumeCommand({
            path: '/tmp/project',
            flavor: 'codex',
            codexThreadId: 'thread-1',
            client: { id: 'rig' },
            capabilities: { resume: false },
        }, 'cmsession1')).toBeNull();
    });
    it('builds a resume command for the session that enters the session directory first', () => {
        expect(buildResumeCommand({
            path: '/tmp/project',
            os: 'darwin',
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        }, 'cmsession1')).toBe(`cd '/tmp/project' && happycc resume cmsession1`);
    });

    it('builds a Windows resume command for a Codex session using PowerShell directory navigation', () => {
        expect(buildResumeCommand({
            path: 'C:\\Users\\test\\project',
            os: 'win32',
            flavor: 'codex',
            codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
        }, 'cmsession1')).toBe(`Set-Location -LiteralPath 'C:\\Users\\test\\project'; happycc resume cmsession1`);
    });

    it('falls back to the bare resume command when no path is available', () => {
        expect(buildResumeCommand({
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        }, 'cmsession1')).toBe('happycc resume cmsession1');
    });

    it('returns null when there is no resumable session identifier', () => {
        expect(buildResumeCommand({
            path: '/tmp/project',
            flavor: 'claude',
        }, 'cmsession1')).toBeNull();
    });
});

describe('buildResumeCommandBlock', () => {
    it('builds copyable two-line CLI instructions when a path is available', () => {
        expect(buildResumeCommandBlock({
            path: '/tmp/project',
            os: 'darwin',
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        }, 'cmsession1')).toEqual({
            lines: [
                `cd '/tmp/project'`,
                'happycc resume cmsession1',
            ],
            copyText: `cd '/tmp/project'\nhappycc resume cmsession1`,
        });
    });

    it('falls back to a single-line command block when no path is available', () => {
        expect(buildResumeCommandBlock({
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        }, 'cmsession1')).toEqual({
            lines: ['happycc resume cmsession1'],
            copyText: 'happycc resume cmsession1',
        });
    });

    it('builds copyable two-line Windows instructions using PowerShell directory navigation', () => {
        expect(buildResumeCommandBlock({
            path: 'C:\\Users\\test\\project',
            os: 'win32',
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        }, 'cmsession1')).toEqual({
            lines: [
                `Set-Location -LiteralPath 'C:\\Users\\test\\project'`,
                'happycc resume cmsession1',
            ],
            copyText: `Set-Location -LiteralPath 'C:\\Users\\test\\project'\nhappycc resume cmsession1`,
        });
    });
});
