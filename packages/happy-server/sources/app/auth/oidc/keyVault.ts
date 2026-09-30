import * as privacyKit from 'privacy-kit';
import { decryptBytes, decryptString, encryptBytes, encryptString } from '@/modules/encrypt';

const ROOT_SECRET_PATH = ['oidc', 'account-root-secret'];
const IDP_REFRESH_TOKEN_PATH = ['oidc', 'idp-refresh-token'];

export class KeyVaultError extends Error {
    constructor(message = 'Failed to unwrap secret') {
        super(message);
        this.name = 'KeyVaultError';
    }
}

function toBytes(base64: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(privacyKit.decodeBase64(base64));
}

/** v1 key vault: KeyTree derived from HANDY_MASTER_SECRET. Swap for a KMS later. */
export const keyVault = {
    wrap(secret: Uint8Array): string {
        return privacyKit.encodeBase64(encryptBytes(ROOT_SECRET_PATH, new Uint8Array(secret)));
    },
    unwrap(wrapped: string): Uint8Array {
        let result: Uint8Array | null;
        try {
            result = decryptBytes(ROOT_SECRET_PATH, toBytes(wrapped));
        } catch {
            throw new KeyVaultError();
        }
        if (!result) {
            throw new KeyVaultError();
        }
        return result;
    },
};

export function sealIdpRefreshToken(token: string): string {
    return privacyKit.encodeBase64(encryptString(IDP_REFRESH_TOKEN_PATH, token));
}

export function openIdpRefreshToken(sealed: string): string {
    try {
        return decryptString(IDP_REFRESH_TOKEN_PATH, toBytes(sealed));
    } catch {
        throw new KeyVaultError('Failed to open IdP refresh token');
    }
}
