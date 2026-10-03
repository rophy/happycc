// Usage: node signin.mjs <url> <user>
// Completes the OIDC sign-in a CLI printed: follows redirects with a cookie jar,
// submits oidc-mock's user form for <user>, then our confirmation page
// (decision=approve for the device flow, decision=allow for loopback).
const [startUrl, user] = process.argv.slice(2);
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function request(url, init = {}) {
    for (let hops = 0; hops < 15; hops++) {
        const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...init.headers, cookie: cookieHeader() } });
        for (const c of res.headers.getSetCookie?.() ?? []) {
            const [pair] = c.split(';');
            const i = pair.indexOf('=');
            jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
            url = new URL(location, url).toString();
            init = {};
            continue;
        }
        return { url, status: res.status, body: await res.text() };
    }
    throw new Error('Too many redirects');
}

const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function forms(html) {
    return [...html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)].map(([f]) => ({
        action: decode(attr(f.match(/<form[^>]*>/)[0], 'action')),
        fields: Object.fromEntries([...f.matchAll(/<input[^>]*>/g)].map(([i]) => [attr(i, 'name'), decode(attr(i, 'value'))]).filter(([n]) => n)),
        decisions: [...f.matchAll(/<button[^>]*name="decision"[^>]*value="([^"]*)"/g)].map((m) => m[1]),
    }));
}

let page = await request(startUrl);
for (let step = 0; step < 6; step++) {
    const all = forms(page.body);
    const userForm = all.find((f) => f.fields.sub === user);
    const confirm = all.find((f) => f.fields.csrf && f.decisions.some((d) => d === 'approve' || d === 'allow'));
    const form = userForm ?? confirm;
    if (!form) break;
    const fields = { ...form.fields };
    if (form === confirm) fields.decision = form.decisions.find((d) => d === 'approve' || d === 'allow');
    page = await request(new URL(form.action, page.url).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
    });
}
if (page.status >= 400) {
    console.error(`Sign-in ended with HTTP ${page.status} at ${page.url}`);
    process.exit(1);
}
console.log(`Sign-in finished at ${page.url}`);
