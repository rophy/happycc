import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessTokenProvider, staticAccessTokenProvider } from '@/auth/authFetch';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://api.test.com' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'test-client' }));

import { fetchServerFeatures, serverFeaturesDefaults } from './apiFeatures';

describe('fetchServerFeatures', () => {
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

    it('reads /v1/features with a Bearer token', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ voice: true, githubConnect: false, push: true }), { status: 200 }));
        await expect(fetchServerFeatures()).resolves.toEqual({ voice: true, githubConnect: false, push: true });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.test.com/v1/features',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer test-token', 'X-Happy-Client': 'test-client' }),
            }),
        );
    });

    it('treats a server without the endpoint as having every integration off', async () => {
        fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
        await expect(fetchServerFeatures()).resolves.toEqual({ voice: false, githubConnect: false, push: false });
        expect(serverFeaturesDefaults).toEqual({ voice: false, githubConnect: false, push: false });
    });

    it('throws on other failures so the sync retries', async () => {
        fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
        await expect(fetchServerFeatures()).rejects.toThrow('500');
    });

    it('rejects a malformed response', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ voice: 'yes' }), { status: 200 }));
        await expect(fetchServerFeatures()).rejects.toThrow();
    });
});
