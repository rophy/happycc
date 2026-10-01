import {
    VoiceConversationResponseSchema,
    VoiceUsageResponseSchema,
    type VoiceConversationResponse,
    type VoiceUsageResponse,
} from '@slopus/happy-wire';
import { AuthCredentials } from '@/auth/tokenStorage';
import { authFetch, headersToRecord } from '@/auth/authFetch';
import { getServerUrl, getVoiceServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { config } from '@/config';
import { authGetToken } from '@/auth/authGetToken';
import { decodeBase64 } from '@/encryption/base64';

export type { VoiceConversationResponse, VoiceUsageResponse };

/**
 * The voice endpoint is usually our own server (OIDC access token via
 * authFetch). When the user opted a custom self-hosted server into handling
 * sessions but kept voice on the default server (`getVoiceServerUrl() !==
 * getServerUrl()`), that other server never saw this device's OIDC sign-in —
 * it only has the account's root secret, so it's authenticated the legacy
 * way (`authGetToken`, the old challenge/signature flow) instead.
 */
async function voiceFetch(credentials: AuthCredentials, path: string, init: RequestInit): Promise<Response> {
    const voiceServerUrl = getVoiceServerUrl();
    const url = `${voiceServerUrl}${path}`;
    if (voiceServerUrl === getServerUrl()) {
        return authFetch(url, init);
    }
    const secret = decodeBase64(credentials.secret, 'base64url');
    const token = await authGetToken(secret, voiceServerUrl);
    const headers = headersToRecord(init.headers);
    headers.Authorization = `Bearer ${token}`;
    return fetch(url, { ...init, headers });
}

export async function fetchVoiceCredentials(
    credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceConversationResponse> {
    const agentId = config.elevenLabsAgentId;

    if (!agentId) {
        throw new Error('Agent ID not configured');
    }

    const response = await voiceFetch(credentials, '/v1/voice/conversations', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify({
            agentId
        })
    });

    if (!response.ok) {
        throw new Error(`Voice token request failed: ${response.status}`);
    }

    return VoiceConversationResponseSchema.parse(await response.json());
}

export async function fetchVoiceUsage(
    credentials: AuthCredentials
): Promise<VoiceUsageResponse> {
    const response = await voiceFetch(credentials, '/v1/voice/usage', {
        method: 'GET',
        headers: {
            'X-Happy-Client': getHappyClientId(),
        },
    });

    if (!response.ok) {
        throw new Error(`Voice usage request failed: ${response.status}`);
    }

    return VoiceUsageResponseSchema.parse(await response.json());
}
