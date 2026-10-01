import { z } from "zod";
import { type Fastify, GitHubProfile } from "../types";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";
import { githubConnect } from "@/app/github/githubConnect";
import { githubDisconnect } from "@/app/github/githubDisconnect";
import { Context } from "@/context";
import type { GithubOAuthConfig } from "@/app/features/featuresConfig";

/** `${WEBAPP_URL}/?<params>`; WEBAPP_URL may carry a path. */
export function webappRedirectUrl(webappUrl: string, params: Record<string, string>): string {
    const url = new URL(`${webappUrl}/`);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    return url.toString();
}

/**
 * GitHub account connect. Registered only when GITHUB_CLIENT_ID,
 * GITHUB_CLIENT_SECRET and GITHUB_REDIRECT_URL are all set. The OAuth
 * callback always returns to WEBAPP_URL.
 */
export function githubRoutes(app: Fastify, opts: { github: GithubOAuthConfig; webappUrl: string }) {
    const { github, webappUrl } = opts;
    const backToWebapp = (params: Record<string, string>) => webappRedirectUrl(webappUrl, params);

    app.get('/v1/connect/github/params', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({ url: z.string() }),
            },
        },
    }, async (request, reply) => {
        // Ephemeral state token (5 minutes TTL)
        const state = await auth.createGithubToken(request.userId);
        const params = new URLSearchParams({
            client_id: github.clientId,
            redirect_uri: github.redirectUrl,
            scope: 'read:user,user:email,read:org,codespace',
            state,
        });
        return reply.send({ url: `https://github.com/login/oauth/authorize?${params.toString()}` });
    });

    app.get('/v1/connect/github/callback', {
        schema: {
            querystring: z.object({
                code: z.string(),
                state: z.string(),
            }),
        },
    }, async (request, reply) => {
        const { code, state } = request.query;

        const tokenData = await auth.verifyGithubToken(state);
        if (!tokenData) {
            // Never log the state value: it is a bearer token for this flow.
            log({ module: 'github-oauth' }, 'Invalid or expired GitHub OAuth state');
            return reply.redirect(backToWebapp({ error: 'invalid_state' }));
        }

        try {
            const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    client_id: github.clientId,
                    client_secret: github.clientSecret,
                    code,
                }),
            });
            const tokenResponseData = await tokenResponse.json() as {
                access_token?: string;
                error?: string;
                error_description?: string;
            };
            if (tokenResponseData.error) {
                return reply.redirect(backToWebapp({ error: tokenResponseData.error }));
            }
            const accessToken = tokenResponseData.access_token;

            const userResponse = await fetch('https://api.github.com/user', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                },
            });
            const userData = await userResponse.json() as GitHubProfile;
            if (!userResponse.ok) {
                return reply.redirect(backToWebapp({ error: 'github_user_fetch_failed' }));
            }

            const ctx = Context.create(tokenData.userId);
            await githubConnect(ctx, userData, accessToken!);
            return reply.redirect(backToWebapp({ github: 'connected', user: userData.login }));
        } catch (error) {
            log({ module: 'github-oauth' }, `Error in GitHub GET callback: ${error instanceof Error ? error.message : String(error)}`);
            return reply.redirect(backToWebapp({ error: 'server_error' }));
        }
    });

    app.post('/v1/connect/github/webhook', {
        schema: {
            headers: z.object({
                'x-hub-signature-256': z.string(),
                'x-github-event': z.string(),
                'x-github-delivery': z.string().optional(),
            }).passthrough(),
            body: z.any(),
            response: {
                200: z.object({ received: z.boolean() }),
                401: z.object({ error: z.string() }),
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const signature = request.headers['x-hub-signature-256'];
        const eventName = request.headers['x-github-event'];
        const deliveryId = request.headers['x-github-delivery'];
        // Set by the JSON content-type parser registered in connectRoutes.
        const rawBody = (request as any).rawBody;

        if (!rawBody) {
            log({ module: 'github-webhook', level: 'error' }, 'Raw body not available for webhook signature verification');
            return reply.code(500).send({ error: 'Server configuration error' });
        }

        const { getWebhooks } = await import("@/modules/github");
        const webhooks = getWebhooks();
        if (!webhooks) {
            log({ module: 'github-webhook', level: 'error' }, 'GitHub webhooks not initialized');
            return reply.code(500).send({ error: 'Webhooks not configured' });
        }

        try {
            await webhooks.verifyAndReceive({
                id: deliveryId || 'unknown',
                name: eventName,
                payload: typeof rawBody === 'string' ? rawBody : JSON.stringify(request.body),
                signature,
            });
            return reply.send({ received: true });
        } catch {
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    app.delete('/v1/connect/github', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({ success: z.literal(true) }),
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        try {
            await githubDisconnect(ctx);
            return reply.send({ success: true });
        } catch {
            return reply.code(500).send({ error: 'Failed to disconnect GitHub account' });
        }
    });
}
