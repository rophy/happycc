import type { FeaturesResponse } from '@slopus/happy-wire';

export interface VoiceConfig {
    apiKey: string;
    agentId: string;
    /** null = no cap. Counted over the rolling 30 days ElevenLabs reports. */
    monthlyLimitSeconds: number | null;
}

export interface GithubOAuthConfig {
    clientId: string;
    clientSecret: string;
    redirectUrl: string;
}

export interface FeaturesConfig {
    voice: VoiceConfig | null;
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

function parseMonthlyLimitSeconds(value: string | null): number | null {
    if (value === null) {
        return null;
    }
    if (!/^\d+$/.test(value) || parseInt(value, 10) <= 0) {
        throw new Error(`VOICE_MONTHLY_LIMIT_MINUTES must be a positive whole number of minutes, got "${value}"`);
    }
    return parseInt(value, 10) * 60;
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
    const voice = allOrNone(env, ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID'], 'Voice');
    const github = allOrNone(env, ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_REDIRECT_URL'], 'GitHub connect');
    const monthlyLimitSeconds = parseMonthlyLimitSeconds(optional(env, 'VOICE_MONTHLY_LIMIT_MINUTES'));
    return {
        voice: voice ? { apiKey: voice[0], agentId: voice[1], monthlyLimitSeconds } : null,
        github: github ? { clientId: github[0], clientSecret: github[1], redirectUrl: github[2] } : null,
        pushEnabled: parsePushEnabled(optional(env, 'PUSH_ENABLED')),
    };
}

export function publicFeatures(config: FeaturesConfig): PublicFeatures {
    return {
        voice: config.voice !== null,
        githubConnect: config.github !== null,
        push: config.pushEnabled,
    };
}

export function describeFeatures(config: FeaturesConfig): string {
    const voice = config.voice
        ? `on${config.voice.monthlyLimitSeconds !== null ? ` (cap ${config.voice.monthlyLimitSeconds / 60} min/30 days)` : ''}`
        : 'off';
    return `voice=${voice} githubConnect=${config.github ? 'on' : 'off'} push=${config.pushEnabled ? 'on' : 'off'}`;
}
