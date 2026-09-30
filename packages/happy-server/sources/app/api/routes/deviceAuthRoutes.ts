import { z } from 'zod';
import * as privacyKit from 'privacy-kit';
import { type Fastify } from '../types';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import type { AuthRouteDeps } from './oidcRoutes';
import { boxForRecipient, cliKeyBundlePlaintext, decodeEphemeralPublicKey } from '@/app/auth/oidc/accountKeys';
import { keyVault } from '@/app/auth/oidc/keyVault';
import { createDevice } from '@/app/auth/oidc/devices';
import {
    DEVICE_CODE_TTL_SEC, POLL_INTERVAL_SEC,
    decideDeviceAuth, findPendingRequest, normalizeUserCode, pollDeviceAuth, startDeviceAuth,
} from '@/app/auth/oidc/deviceAuth';
import { SESSION_COOKIE, readCookie, signValue, verifyValue } from '@/app/auth/oidc/browserCookies';
import { confirmPage, enterCodePage, idpUnavailablePage, messagePage, sendHtml } from '@/app/auth/oidc/pages';

const CSRF_PURPOSE = 'activate-csrf';

export function deviceAuthRoutes(app: Fastify, deps: AuthRouteDeps) {
    const { config } = deps;

    // Browsers post the approval form as application/x-www-form-urlencoded.
    if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
        app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
            done(null, Object.fromEntries(new URLSearchParams(body as string)));
        });
    }

    app.post('/v1/auth/device/start', {
        schema: {
            body: z.object({
                ephemeralPublicKey: z.string().max(128),
                clientInfo: z.object({
                    host: z.string().min(1).max(255),
                    os: z.string().max(64),
                    cliVersion: z.string().max(64),
                }),
            }),
        },
    }, async (request, reply) => {
        if (!decodeEphemeralPublicKey(request.body.ephemeralPublicKey)) {
            return reply.code(400).send({ error: 'invalid_request' });
        }
        const { deviceCode, userCode } = await startDeviceAuth(request.body);
        return reply.send({
            deviceCode,
            userCode,
            verifyUrl: `${config.publicUrl}/activate`,
            verifyUrlComplete: `${config.publicUrl}/activate?code=${userCode}`,
            interval: POLL_INTERVAL_SEC,
            expiresIn: DEVICE_CODE_TTL_SEC,
        });
    });

    app.post('/v1/auth/device/token', {
        schema: { body: z.object({ deviceCode: z.string().max(256) }) },
    }, async (request, reply) => {
        const result = await pollDeviceAuth(request.body.deviceCode);
        switch (result.status) {
            case 'pending': return reply.code(400).send({ error: 'authorization_pending' });
            case 'slow_down': return reply.code(400).send({ error: 'slow_down' });
            case 'expired': return reply.code(400).send({ error: 'expired_token' });
            case 'denied': return reply.code(400).send({ error: 'access_denied' });
            case 'invalid': return reply.code(400).send({ error: 'invalid_grant' });
        }
        const account = await db.account.findUniqueOrThrow({ where: { id: result.accountId } });
        if (account.disabledAt) {
            return reply.code(400).send({ error: 'invalid_grant' });
        }
        let rootSecret: Uint8Array;
        try {
            rootSecret = keyVault.unwrap(account.wrappedRootSecret!);
        } catch {
            log({ module: 'auth', level: 'error' }, `ALERT: cannot unwrap root secret for account ${account.id}`);
            return reply.code(500).send({ error: 'server_error' });
        }
        const device = await createDevice({
            accountId: account.id,
            kind: 'cli',
            name: result.clientInfo.host,
            host: result.clientInfo.host,
        });
        const ephemeral = decodeEphemeralPublicKey(result.ephemeralPublicKey)!;
        return reply.send({
            accountId: account.id,
            accessToken: device.accessToken,
            refreshToken: device.refreshToken,
            keyBundle: privacyKit.encodeBase64(new Uint8Array(boxForRecipient(cliKeyBundlePlaintext(rootSecret), ephemeral))),
        });
    });

    app.get('/activate', {
        schema: { querystring: z.object({ code: z.string().max(32).optional() }) },
    }, async (request, reply) => {
        const session = readCookie<{ accountId: string }>(request.headers.cookie, SESSION_COOKIE);
        const rawCode = request.query.code;
        if (!session) {
            if (!deps.oidc.isReady()) {
                return sendHtml(reply, 503, idpUnavailablePage());
            }
            const next = rawCode ? `&user_code=${encodeURIComponent(rawCode)}` : '';
            return reply.redirect(`/v1/auth/oidc/login?client=activate${next}`);
        }
        if (!rawCode) {
            return sendHtml(reply, 200, enterCodePage({}));
        }
        const userCode = normalizeUserCode(rawCode);
        const pending = userCode ? await findPendingRequest(userCode) : null;
        if (!pending) {
            return sendHtml(reply, 200, enterCodePage({ code: rawCode, error: 'Code not found or expired. Check your terminal and try again.' }));
        }
        const csrf = signValue(CSRF_PURPOSE, { accountId: session.accountId, userCode: pending.userCode }, 600);
        return sendHtml(reply, 200, confirmPage({ userCode: pending.userCode, ...pending.clientInfo, csrf }));
    });

    app.post('/activate', {
        schema: {
            body: z.object({
                code: z.string().max(32),
                csrf: z.string().max(2048),
                decision: z.enum(['approve', 'deny']),
            }),
        },
    }, async (request, reply) => {
        const session = readCookie<{ accountId: string }>(request.headers.cookie, SESSION_COOKIE);
        if (!session) {
            return sendHtml(reply, 401, messagePage('Sign-in expired', 'Please open the link from your terminal again.'));
        }
        const csrf = verifyValue<{ accountId: string; userCode: string }>(CSRF_PURPOSE, request.body.csrf);
        if (!csrf || csrf.accountId !== session.accountId || csrf.userCode !== request.body.code) {
            return sendHtml(reply, 403, messagePage('Request rejected', 'This approval form is no longer valid. Please start again.'));
        }
        const ok = await decideDeviceAuth(request.body.code, session.accountId, request.body.decision);
        if (!ok) {
            return sendHtml(reply, 200, messagePage('Code expired', 'This code has expired or was already used. Run the login command again.'));
        }
        return request.body.decision === 'approve'
            ? sendHtml(reply, 200, messagePage('Terminal authorized', 'Return to your terminal to continue.'))
            : sendHtml(reply, 200, messagePage('Request denied', 'The terminal was not signed in.'));
    });
}
