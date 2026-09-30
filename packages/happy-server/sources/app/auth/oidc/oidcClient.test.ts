import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OAuth2Server } from 'oauth2-mock-server';
import { createOidcClient, newLoginParams, type OidcClient } from './oidcClient';

const redirectUri = 'http://localhost:3005/v1/auth/oidc/callback';
let server: OAuth2Server;
let client: OidcClient;
let nonceForNextToken: string | null = null;

beforeAll(async () => {
    server = new OAuth2Server();
    await server.issuer.keys.generate('RS256');
    await server.start(0, '127.0.0.1');
    server.service.on('beforeTokenSigning', (token) => {
        token.payload.sub = 'alice';
        token.payload.email = 'alice@example.com';
        token.payload.name = 'Alice Example';
        if (nonceForNextToken) token.payload.nonce = nonceForNextToken;
    });
    client = await createOidcClient(
        { issuer: server.issuer.url!, clientId: 'happy-server', clientSecret: 'secret', scopes: 'openid email profile', redirectUri },
        { allowInsecureRequests: true },
    );
});

afterAll(async () => {
    await server.stop();
});

async function authorize(params: ReturnType<typeof newLoginParams>): Promise<URL> {
    const loginUrl = await client.buildLoginUrl(params);
    const response = await fetch(loginUrl, { redirect: 'manual' });
    return new URL(response.headers.get('location')!);
}

describe('oidcClient', () => {
    it('builds a PKCE login URL', async () => {
        const params = newLoginParams();
        const url = await client.buildLoginUrl(params);
        expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('state')).toBe(params.state);
        expect(url.searchParams.get('nonce')).toBe(params.nonce);
        expect(url.searchParams.get('code_challenge')).not.toBe(params.codeVerifier);
    });

    it('completes the code flow and returns the identity', async () => {
        const params = newLoginParams();
        nonceForNextToken = params.nonce;
        const callback = await authorize(params);
        const identity = await client.handleCallback(callback, params);
        expect(identity).toMatchObject({
            issuer: server.issuer.url,
            subject: 'alice',
            email: 'alice@example.com',
            name: 'Alice Example',
        });
        expect(identity.refreshToken).toEqual(expect.any(String));
    });

    it('rejects a nonce mismatch', async () => {
        const params = newLoginParams();
        nonceForNextToken = 'someone-elses-nonce';
        const callback = await authorize(params);
        await expect(client.handleCallback(callback, params)).rejects.toThrow();
    });

    it('rejects a state mismatch', async () => {
        const params = newLoginParams();
        nonceForNextToken = params.nonce;
        const callback = await authorize(params);
        await expect(client.handleCallback(callback, { ...params, state: 'other' })).rejects.toThrow();
    });

    it('refreshes and reports invalid_grant as rejected', async () => {
        const params = newLoginParams();
        nonceForNextToken = params.nonce;
        const identity = await client.handleCallback(await authorize(params), params);
        expect((await client.refresh(identity.refreshToken!)).status).toBe('ok');

        server.service.once('beforeResponse', (response, req) => {
            if (req.body.grant_type === 'refresh_token') {
                response.statusCode = 400;
                response.body = { error: 'invalid_grant' };
            }
        });
        expect(await client.refresh(identity.refreshToken!)).toEqual({ status: 'rejected' });
    });

    it('reports invalid_client as unavailable, not rejected', async () => {
        server.service.once('beforeResponse', (response, req) => {
            if (req.body.grant_type === 'refresh_token') {
                response.statusCode = 401;
                response.body = { error: 'invalid_client' };
            }
        });
        expect(await client.refresh('any')).toEqual({ status: 'unavailable' });
    });

    it('reports an unreachable IdP as unavailable', async () => {
        server.service.once('beforeResponse', (response, req) => {
            if (req.body.grant_type === 'refresh_token') {
                response.statusCode = 503;
                response.body = { error: 'temporarily_unavailable' };
            }
        });
        expect(await client.refresh('any')).toEqual({ status: 'unavailable' });
    });
});
