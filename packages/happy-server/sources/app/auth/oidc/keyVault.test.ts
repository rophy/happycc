import { beforeAll, describe, expect, it } from 'vitest';
import { initEncrypt } from '@/modules/encrypt';
import { KeyVaultError, keyVault, openIdpRefreshToken, sealIdpRefreshToken } from './keyVault';

beforeAll(async () => {
    process.env.HANDY_MASTER_SECRET = 'test-master-secret-that-is-long-enough-000';
    await initEncrypt();
});

describe('keyVault', () => {
    it('round-trips a root secret', () => {
        const secret = new Uint8Array(32).fill(7);
        const wrapped = keyVault.wrap(secret);
        expect(typeof wrapped).toBe('string');
        expect(wrapped).not.toContain(Buffer.from(secret).toString('base64'));
        expect(Buffer.from(keyVault.unwrap(wrapped)).equals(Buffer.from(secret))).toBe(true);
    });

    it('throws KeyVaultError on tampered input', () => {
        const wrapped = keyVault.wrap(new Uint8Array(32).fill(1));
        const bytes = Buffer.from(wrapped, 'base64');
        bytes[bytes.length - 1] ^= 0xff;
        expect(() => keyVault.unwrap(bytes.toString('base64'))).toThrow(KeyVaultError);
    });

    it('round-trips an IdP refresh token', () => {
        const sealed = sealIdpRefreshToken('idp-refresh-token');
        expect(sealed).not.toContain('idp-refresh-token');
        expect(openIdpRefreshToken(sealed)).toBe('idp-refresh-token');
    });
});
