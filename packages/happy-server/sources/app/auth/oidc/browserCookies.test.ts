import { beforeAll, describe, expect, it } from 'vitest';
import { clearCookieHeader, initBrowserCookies, readCookie, setCookieHeader, signValue, verifyValue } from './browserCookies';

beforeAll(() => initBrowserCookies({ masterSecret: 'test-master-secret-that-is-long-enough-000', secure: true }));

describe('browserCookies', () => {
    it('sets hardened cookies and reads them back', () => {
        const header = setCookieHeader('happy_session', { accountId: 'acc_1' }, 600);
        expect(header).toMatch(/^happy_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
        const cookie = header.split(';')[0];
        expect(readCookie<{ accountId: string }>(`other=1; ${cookie}`, 'happy_session')?.accountId).toBe('acc_1');
    });

    it('does not accept a cookie under another name', () => {
        const value = setCookieHeader('happy_oidc_login', { accountId: 'acc_1' }, 600).split(';')[0].split('=')[1];
        expect(readCookie(`happy_session=${value}`, 'happy_session')).toBeNull();
    });

    it('rejects tampered values', () => {
        const value = setCookieHeader('happy_session', { accountId: 'acc_1' }, 600).split(';')[0].split('=')[1];
        expect(readCookie(`happy_session=${value}x`, 'happy_session')).toBeNull();
    });

    it('clears cookies', () => {
        expect(clearCookieHeader('happy_session')).toBe('happy_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
    });

    it('binds signed values to a purpose', () => {
        const token = signValue('activate-csrf', { userCode: 'BCDF-GHJK' }, 600);
        expect(verifyValue<{ userCode: string }>('activate-csrf', token)?.userCode).toBe('BCDF-GHJK');
        expect(verifyValue('other-purpose', token)).toBeNull();
        expect(verifyValue('activate-csrf', undefined)).toBeNull();
    });
});
