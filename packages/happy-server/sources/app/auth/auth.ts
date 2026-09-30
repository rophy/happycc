import * as privacyKit from "privacy-kit";
import { debug, log } from "@/utils/log";
import { AccessTokenClaims, verifyAccessToken } from "./oidc/accessTokens";

interface AuthTokens {
    githubVerifier: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenVerifier>>;
    githubGenerator: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenGenerator>>;
}

class AuthModule {
    private tokens: AuthTokens | null = null;

    async init(): Promise<void> {
        if (this.tokens) {
            return; // Already initialized
        }

        log({ module: 'auth' }, 'Initializing auth module...');

        const githubGenerator = await privacyKit.createEphemeralTokenGenerator({
            service: 'github-happy',
            seed: process.env.HANDY_MASTER_SECRET!,
            ttl: 5 * 60 * 1000 // 5 minutes
        });

        const githubVerifier = await privacyKit.createEphemeralTokenVerifier({
            service: 'github-happy',
            publicKey: Uint8Array.from(githubGenerator.publicKey),
        });


        this.tokens = { githubVerifier, githubGenerator };

        log({ module: 'auth' }, 'Auth module initialized');
    }

    async verifyToken(token: string): Promise<AccessTokenClaims | null> {
        return verifyAccessToken(token);
    }

    async createGithubToken(userId: string): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        const payload = { user: userId, purpose: 'github-oauth' };
        const token = await this.tokens.githubGenerator.new(payload);

        return token;
    }

    async verifyGithubToken(token: string): Promise<{ userId: string } | null> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        try {
            const verified = await this.tokens.githubVerifier.verify(token);
            if (!verified) {
                return null;
            }

            return { userId: verified.user as string };
        } catch (error) {
            debug({ module: 'auth' }, `auth:github-token-verification-failed error=${error}`);
            return null;
        }
    }
}

// Global instance
export const auth = new AuthModule();
