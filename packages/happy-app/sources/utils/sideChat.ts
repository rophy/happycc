import type { Session } from '@/sync/storageTypes';
import { HappyError } from '@/utils/errors';
import { getSessionForkSource, type ForkSource } from './sessionFork';

/**
 * Where a new side chat would fork from. A side chat is a new session spawned
 * on the machine, so the workstation-only build has none.
 */
export function getSideChatForkSource(session: Session | null | undefined, workstationOnly: boolean): ForkSource | null {
    if (!session || workstationOnly) return null;
    return getSessionForkSource(session);
}

/** Spawns the side chat, or refuses with `unavailableMessage` when there is nothing to fork. */
export async function spawnSideChatFrom<R>(
    source: ForkSource | null,
    spawn: (source: ForkSource) => Promise<R>,
    unavailableMessage: string,
): Promise<R> {
    if (!source) {
        throw new HappyError(unavailableMessage, false);
    }
    return spawn(source);
}
