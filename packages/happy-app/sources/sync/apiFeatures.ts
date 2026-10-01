import { FeaturesResponseSchema, type FeaturesResponse } from '@slopus/happy-wire';
import { authFetch } from '@/auth/authFetch';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

/** Server-side integrations this deployment turned on (GET /v1/features). */
export type ServerFeatures = FeaturesResponse;

/** Everything off until the server says otherwise. */
export const serverFeaturesDefaults: ServerFeatures = Object.freeze({
    voice: false,
    githubConnect: false,
    push: false,
});

export async function fetchServerFeatures(): Promise<ServerFeatures> {
    const response = await authFetch(`${getServerUrl()}/v1/features`, {
        headers: {
            'X-Happy-Client': getHappyClientId(),
        },
    });
    if (response.status === 404) {
        // A server without the endpoint offers no optional integrations.
        return { ...serverFeaturesDefaults };
    }
    if (!response.ok) {
        throw new Error(`Failed to fetch features: ${response.status}`);
    }
    return FeaturesResponseSchema.parse(await response.json());
}
