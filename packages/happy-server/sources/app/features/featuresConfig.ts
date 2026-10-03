import type { FeaturesResponse } from '@slopus/happy-wire';

export interface GithubOAuthConfig {
    clientId: string;
    clientSecret: string;
    redirectUrl: string;
}

export interface FeaturesConfig {
    github: GithubOAuthConfig | null;
    pushEnabled: boolean;
}

export type PublicFeatures = FeaturesResponse;

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
    const value = env[name]?.trim();
    return value ? value : null;
}

/** All of `names` set → their values; none set → null; some set → startup error (names only, never values). */
function allOrNone(env: NodeJS.ProcessEnv, names: string[], label: string): string[] | null {
    const values = names.map((name) => optional(env, name));
    const present = names.filter((_, i) => values[i] !== null);
    if (present.length === 0) {
        return null;
    }
    if (present.length !== names.length) {
        const missing = names.filter((_, i) => values[i] === null);
        throw new Error(`${label} is partially configured: set ${missing.join(' and ')} too, or unset ${present.join(' and ')}`);
    }
    return values as string[];
}

function parsePushEnabled(value: string | null): boolean {
    if (value === null) {
        return true;
    }
    const normalized = value.toLowerCase();
    if (normalized === 'true' || normalized === '1') {
        return true;
    }
    if (normalized === 'false' || normalized === '0') {
        return false;
    }
    throw new Error(`PUSH_ENABLED must be true or false, got "${value}"`);
}

export function loadFeaturesConfig(env: NodeJS.ProcessEnv = process.env): FeaturesConfig {
    const github = allOrNone(env, ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_REDIRECT_URL'], 'GitHub connect');
    return {
        github: github ? { clientId: github[0], clientSecret: github[1], redirectUrl: github[2] } : null,
        pushEnabled: parsePushEnabled(optional(env, 'PUSH_ENABLED')),
    };
}

export function publicFeatures(config: FeaturesConfig): PublicFeatures {
    return {
        githubConnect: config.github !== null,
        push: config.pushEnabled,
    };
}

export function describeFeatures(config: FeaturesConfig): string {
    return `githubConnect=${config.github ? 'on' : 'off'} push=${config.pushEnabled ? 'on' : 'off'}`;
}
