/**
 * Only a CLI session socket may register RPC methods, and only for its own
 * session. Machine-scoped (daemon) and user-scoped (app) sockets may not, so a
 * client cannot register — and intercept — another session's methods.
 */
export function canRegisterRpc(method: string, socketData: { clientType?: string; sessionId?: string }): boolean {
    if (socketData.clientType !== 'session-scoped' || !socketData.sessionId) {
        return false;
    }
    return method.startsWith(`${socketData.sessionId}:`) && method.length > socketData.sessionId.length + 1;
}
