import { db } from '@/storage/db';
import { log } from '@/utils/log';
import { revokeAccountDevices } from './devices';
import { KeyVaultError, openIdpRefreshToken, sealIdpRefreshToken } from './keyVault';
import type { OidcClient } from './oidcClient';

export const IDP_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Returns a check used on refresh: at most once per interval per account, refresh the
 * stored IdP token. invalid_grant or an unreadable stored token → revoke all devices;
 * IdP unreachable → allow.
 */
export function createIdpCheck(deps: { oidc: Pick<OidcClient, 'refresh'>; now?: () => Date }) {
    return async function checkIdp(accountId: string): Promise<boolean> {
        const account = await db.account.findUnique({
            where: { id: accountId },
            select: { idpRefreshToken: true, idpCheckedAt: true },
        });
        if (!account?.idpRefreshToken) {
            return true;
        }
        const now = deps.now?.() ?? new Date();
        if (account.idpCheckedAt && now.getTime() - account.idpCheckedAt.getTime() < IDP_CHECK_INTERVAL_MS) {
            return true;
        }

        // Claim the check so concurrent refreshes don't all hit the IdP with the same token.
        const claimed = await db.account.updateMany({
            where: { id: accountId, idpCheckedAt: account.idpCheckedAt },
            data: { idpCheckedAt: now },
        });
        if (claimed.count !== 1) {
            return true;
        }

        let openedToken: string;
        try {
            openedToken = openIdpRefreshToken(account.idpRefreshToken);
        } catch (error) {
            if (error instanceof KeyVaultError) {
                // Fail closed: without a usable IdP token the account cannot be re-validated.
                log({ module: 'auth', level: 'error' }, `Stored IdP refresh token for account ${accountId} could not be opened; clearing it and revoking devices`);
                await db.account.update({ where: { id: accountId }, data: { idpRefreshToken: null } });
                await revokeAccountDevices(accountId);
                return false;
            }
            throw error;
        }

        const result = await deps.oidc.refresh(openedToken);
        if (result.status === 'rejected') {
            log({ module: 'auth', level: 'warn' }, `IdP rejected account ${accountId}; revoking devices`);
            await db.account.update({ where: { id: accountId }, data: { idpRefreshToken: null } });
            await revokeAccountDevices(accountId);
            return false;
        }
        if (result.status === 'unavailable') {
            log({ module: 'auth', level: 'warn' }, `IdP unavailable while checking account ${accountId}`);
            return true;
        }
        if (result.refreshToken) {
            await db.account.update({
                where: { id: accountId },
                data: { idpRefreshToken: sealIdpRefreshToken(result.refreshToken) },
            });
        }
        return true;
    };
}
