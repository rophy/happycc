import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessTokenProvider, staticAccessTokenProvider } from '@/auth/authFetch';
import type { AuthCredentials } from '@/auth/tokenStorage';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.test.com',
}));

vi.mock('./apiSocket', () => ({
    getHappyClientId: () => 'test-client',
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

    it('requests a conversation without supplying an agent id', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            allowed: true,
            conversationToken: 'conv-token',
            conversationId: 'conv-1',
            agentId: 'agent-from-server',
            elevenUserId: 'user-1',
            usedSeconds: 0,
            limitSeconds: null,
        }), { status: 200 }));

        const response = await fetchVoiceCredentials(credentials, 'session-1');

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.test.com/v1/voice/conversations',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'X-Happy-Client': 'test-client',
                }),
            }),
        );
        expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
        expect(response).toMatchObject({ allowed: true, agentId: 'agent-from-server', limitSeconds: null });
    });

    it('parses a monthly-limit denial', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            allowed: false,
            reason: 'voice_monthly_limit_reached',
            usedSeconds: 600,
            limitSeconds: 600,
            agentId: 'agent-from-server',
        }), { status: 200 }));
        const response = await fetchVoiceCredentials(credentials, 'session-1');
        expect(response).toMatchObject({ allowed: false, reason: 'voice_monthly_limit_reached' });
    });

    it('fetches voice usage from the configured server with a Bearer token', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            usedSeconds: 10,
            limitSeconds: null,
            conversationCount: 1,
            conversationLimit: null,
            elevenUserId: 'user-1',
        }), { status: 200 }));

        const usage = await fetchVoiceUsage(credentials);

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
        expect(usage.limitSeconds).toBeNull();
    });
});
