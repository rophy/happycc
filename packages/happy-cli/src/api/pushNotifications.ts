import axios from 'axios'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import { type AccessTokenSource, resolveAccessToken } from './tokenSource'

export type SessionNotificationKind = 'done' | 'permission' | 'question'

/**
 * Asks the server to notify the user's devices about a session event. Only the
 * kind and the session id leave this machine: the server sends fixed,
 * content-free copy, applies presence suppression, and honors PUSH_ENABLED.
 */
export class PushNotificationClient {
    private readonly tokenSource: AccessTokenSource
    private readonly baseUrl: string

    constructor(token: AccessTokenSource, baseUrl: string) {
        this.tokenSource = token
        this.baseUrl = baseUrl
    }

    private get token(): string {
        return resolveAccessToken(this.tokenSource)
    }

    /** Fire-and-forget: the returned promise never rejects, so callers need not await it. */
    sendSessionNotification(params: { kind: SessionNotificationKind; sessionId: string }): Promise<void> {
        return (async () => {
            try {
                const response = await axios.post<{
                    result?: string
                    tokens?: number
                    delivered?: number
                    reason?: string
                }>(
                    `${this.baseUrl}/v1/sessions/${encodeURIComponent(params.sessionId)}/push-event`,
                    { kind: params.kind },
                    {
                        headers: {
                            'Authorization': `Bearer ${this.token}`,
                            'Content-Type': 'application/json',
                            'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`,
                        },
                        timeout: 15000,
                    }
                )
                const { result, tokens, delivered, reason } = response.data ?? {}
                const detail = [
                    tokens !== undefined ? `tokens=${tokens}` : null,
                    delivered !== undefined ? `delivered=${delivered}` : null,
                    reason ? `reason=${reason}` : null,
                ].filter(Boolean).join(' ')
                logger.debug(
                    result
                        ? `[PUSH] sendSessionNotification ${result} (kind=${params.kind})${detail ? ` ${detail}` : ''}`
                        : `[PUSH] sendSessionNotification accepted by server (kind=${params.kind})`
                )
            } catch (error) {
                // Message only: an axios error object carries the Authorization header.
                logger.debug(`[PUSH] sendSessionNotification failed: ${error instanceof Error ? error.message : String(error)}`)
            }
        })()
    }
}
