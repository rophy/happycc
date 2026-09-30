import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';

export const LOGIN_COOKIE = 'happy_oidc_login';
export const SESSION_COOKIE = 'happy_session';

let signingKey: Buffer | null = null;
let secureCookies = true;

export function initBrowserCookies(opts: { masterSecret: string; secure: boolean }): void {
    signingKey = createHash('sha256').update('happy-browser-cookie:' + opts.masterSecret).digest();
    secureCookies = opts.secure;
}

function key(): Buffer {
    if (!signingKey) {
        throw new Error('Browser cookies not initialized');
    }
    return signingKey;
}

export function signValue(purpose: string, payload: object, ttlSec: number): string {
    return jwt.sign({ ...payload, pur: purpose }, key(), { algorithm: 'HS256', expiresIn: ttlSec });
}

export function verifyValue<T>(purpose: string, token: string | undefined): T | null {
    if (!token) {
        return null;
    }
    try {
        const payload = jwt.verify(token, key(), { algorithms: ['HS256'] });
        if (typeof payload !== 'object' || payload.pur !== purpose) {
            return null;
        }
        return payload as T;
    } catch {
        return null;
    }
}

function attributes(maxAge: number): string {
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
}

export function setCookieHeader(name: string, payload: object, ttlSec: number): string {
    return `${name}=${signValue(`cookie:${name}`, payload, ttlSec)}; ${attributes(ttlSec)}`;
}

export function clearCookieHeader(name: string): string {
    return `${name}=; ${attributes(0)}`;
}

export function readCookie<T>(cookieHeader: string | undefined, name: string): T | null {
    if (!cookieHeader) {
        return null;
    }
    for (const part of cookieHeader.split(';')) {
        const index = part.indexOf('=');
        if (index > 0 && part.slice(0, index).trim() === name) {
            return verifyValue<T>(`cookie:${name}`, part.slice(index + 1).trim());
        }
    }
    return null;
}
