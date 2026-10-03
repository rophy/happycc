import { db } from "@/storage/db";

/** A session-scoped socket may only attach to a session of its own account. */
export async function sessionBelongsToUser(sessionId: string, userId: string): Promise<boolean> {
    const session = await db.session.findFirst({ where: { id: sessionId, accountId: userId }, select: { id: true } });
    return !!session;
}
