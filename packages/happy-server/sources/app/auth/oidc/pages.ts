import type { FastifyReply } from 'fastify';

/** Sends a server-rendered HTML page with anti-framing (clickjacking) headers. */
export function sendHtml(reply: FastifyReply, statusCode: number, html: string) {
    return reply
        .code(statusCode)
        .header('content-type', 'text/html; charset=utf-8')
        .header('X-Frame-Options', 'DENY')
        .header('Content-Security-Policy', "frame-ancestors 'none'")
        .send(html);
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
input,button{font:inherit;padding:.5rem .75rem;margin:.25rem 0}
.code{font-family:ui-monospace,monospace;font-size:1.5rem;letter-spacing:.1em}
.error{color:#b00020}
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

export function messagePage(title: string, message: string): string {
    return page(title, `<p>${escapeHtml(message)}</p>`);
}

export function idpUnavailablePage(): string {
    return messagePage('Sign-in unavailable', 'The identity provider cannot be reached right now. Please try again in a minute.');
}

export function enterCodePage(opts: { code?: string; error?: string }): string {
    const error = opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : '';
    return page('Connect a terminal', `${error}
<p>Enter the code shown in your terminal.</p>
<form method="get" action="/activate">
<input class="code" name="code" autocomplete="off" value="${escapeHtml(opts.code ?? '')}" placeholder="XXXX-XXXX">
<button type="submit">Continue</button>
</form>`);
}

export function loopbackConfirmPage(opts: { port: string; csrf: string }): string {
    return page('Allow happy-agent?', `
<p>Allow happy-agent on this computer to access your account? It will be able to read all your sessions.</p>
<p>Redirect port: <strong>${escapeHtml(opts.port)}</strong></p>
<form method="post" action="/v1/auth/oidc/loopback/confirm">
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`);
}

export function confirmPage(opts: { userCode: string; host: string; os: string; cliVersion: string; csrf: string }): string {
    return page('Authorize terminal?', `
<p>A terminal is asking to sign in to your account.</p>
<p class="code">${escapeHtml(opts.userCode)}</p>
<ul>
<li>Host: <strong>${escapeHtml(opts.host)}</strong></li>
<li>OS: ${escapeHtml(opts.os)}</li>
<li>CLI version: ${escapeHtml(opts.cliVersion)}</li>
</ul>
<p>Only approve if this code matches your terminal and you started this sign-in.</p>
<form method="post" action="/activate">
<input type="hidden" name="code" value="${escapeHtml(opts.userCode)}">
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`);
}
