export interface BrowserResponse {
    url: string;
    status: number;
    body: string;
    location: string | null;
}

/** Minimal browser for integration tests: per-host cookie jar + manual redirect following. */
export class HttpBrowser {
    private jar = new Map<string, Map<string, string>>();

    async get(url: string, opts: { stopAt?: (url: string) => boolean } = {}): Promise<BrowserResponse> {
        return this.request(url, { method: 'GET' }, opts.stopAt);
    }

    async postForm(url: string, fields: Record<string, string>, opts: { stopAt?: (url: string) => boolean } = {}): Promise<BrowserResponse> {
        return this.request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
        }, opts.stopAt);
    }

    private async request(url: string, init: RequestInit, stopAt?: (url: string) => boolean): Promise<BrowserResponse> {
        let current = url;
        let currentInit = init;
        for (let hop = 0; hop < 20; hop++) {
            const target = new URL(current);
            const cookie = this.cookieFor(target.host);
            const res = await fetch(current, {
                ...currentInit,
                redirect: 'manual',
                headers: { ...(currentInit.headers as Record<string, string> | undefined), ...(cookie ? { cookie } : {}) },
            });
            this.store(target.host, res.headers.getSetCookie());
            const location = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && location) {
                const next = new URL(location, current).toString();
                if (stopAt?.(next)) {
                    return { url: current, status: res.status, body: await res.text(), location: next };
                }
                current = next;
                currentInit = { method: 'GET' };
                continue;
            }
            return { url: current, status: res.status, body: await res.text(), location };
        }
        throw new Error(`Too many redirects starting at ${url}`);
    }

    private cookieFor(host: string): string {
        const cookies = this.jar.get(host);
        return cookies ? [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') : '';
    }

    private store(host: string, setCookies: string[]) {
        const cookies = this.jar.get(host) ?? new Map<string, string>();
        for (const header of setCookies) {
            const [pair, ...attrs] = header.split(';');
            const index = pair.indexOf('=');
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1).trim();
            const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
            if (expired) cookies.delete(name); else cookies.set(name, value);
        }
        this.jar.set(host, cookies);
    }
}

export function htmlUnescape(value: string): string {
    return value
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/** Hidden fields of the oidc-mock user-picker form whose `sub` input equals `sub`. */
export function pickerFields(html: string, sub: string): Record<string, string> {
    for (const chunk of html.split('<form').slice(1)) {
        const form = chunk.split('</form>')[0];
        const fields: Record<string, string> = {};
        for (const match of form.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) {
            fields[match[1]] = htmlUnescape(match[2]);
        }
        if (fields.sub === sub) {
            return fields;
        }
    }
    throw new Error(`oidc-mock picker has no user with sub=${sub}`);
}
