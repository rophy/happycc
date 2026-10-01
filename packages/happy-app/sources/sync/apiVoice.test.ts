import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessTokenProvider, staticAccessTokenProvider } from '@/auth/authFetch';
import type { AuthCredentials } from '@/auth/tokenStorage';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.test.com',
}));

vi.mock('./apiSocket', () => ({
    getHappyClientId: () => 'test-client',
}));

vi.mock('@/config', () => ({
    config: { elevenLabsAgentId: 'agent-1' },
}));

import { fetchVoiceCredentials, fetchVoiceUsage } from './apiVoice';

const credentials: AuthCredentials = {
    token: 'test-token',
    refreshToken: 'refresh-1',
    secret: 'test-secret',
};

describe('apiVoice', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        setAccessTokenProvider(staticAccessTokenProvider('test-token', 'https://api.test.com'));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setAccessTokenProvider(null);
    });

    it('fetches voice credentials from the configured server with a Bearer token', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            allowed: true,
            conversationToken: 'conv-token',
            conversationId: 'conv-1',
            agentId: 'agent-1',
            elevenUserId: 'user-1',
            usedSeconds: 0,
            limitSeconds: 100,
        }), { status: 200 }));

        await fetchVoiceCredentials(credentials, 'session-1');

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.test.com/v1/voice/conversations',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'X-Happy-Client': 'test-client',
                    'Content-Type': 'application/json',
                }),
            }),
        );
    });

    it('fetches voice usage from the configured server with a Bearer token', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            usedSeconds: 10,
            limitSeconds: 100,
            conversationCount: 1,
            conversationLimit: 10,
            elevenUserId: 'user-1',
        }), { status: 200 }));

        await fetchVoiceUsage(credentials);

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.test.com/v1/voice/usage',
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'X-Happy-Client': 'test-client',
                }),
            }),
        );
    });

    it('throws when the agent id is not configured', async () => {
        vi.resetModules();
        vi.doMock('@/config', () => ({ config: { elevenLabsAgentId: undefined } }));
        const { fetchVoiceCredentials: fetchWithoutAgent } = await import('./apiVoice');
        await expect(fetchWithoutAgent(credentials, 'session-1')).rejects.toThrow('Agent ID not configured');
    });
});
