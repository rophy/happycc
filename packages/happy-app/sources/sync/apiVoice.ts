import {
    VoiceConversationResponseSchema,
    VoiceUsageResponseSchema,
    type VoiceConversationResponse,
    type VoiceUsageResponse,
} from '@slopus/happy-wire';
import { AuthCredentials } from '@/auth/tokenStorage';
import { authFetch } from '@/auth/authFetch';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

export type { VoiceConversationResponse, VoiceUsageResponse };

export async function fetchVoiceCredentials(
    _credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceConversationResponse> {
    // The server owns the ElevenLabs agent id (ELEVENLABS_AGENT_ID); the app sends none.
    const response = await authFetch(`${getServerUrl()}/v1/voice/conversations`, {
        method: 'POST',
        headers: {
            'X-Happy-Client': getHappyClientId(),
        },
    });

    if (!response.ok) {
        throw new Error(`Voice token request failed: ${response.status}`);
    }

    return VoiceConversationResponseSchema.parse(await response.json());
}

export async function fetchVoiceUsage(
    _credentials: AuthCredentials
): Promise<VoiceUsageResponse> {
    const response = await authFetch(`${getServerUrl()}/v1/voice/usage`, {
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
