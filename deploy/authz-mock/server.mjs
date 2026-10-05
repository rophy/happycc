// Authorization webhook for the local stack: allows everyone except the emails on the deny list.
// The e2e suite edits the list: PUT /deny/<email>, DELETE /deny/<email>.
import { createServer } from 'node:http';

const SECRET = process.env.AUTHZ_WEBHOOK_SECRET ?? 'local-authz-secret';
const denied = new Set();

createServer((req, res) => {
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const deny = req.url?.match(/^\/deny\/(.+)$/);
    if (deny && req.method === 'PUT') { denied.add(decodeURIComponent(deny[1])); return send(200, { denied: [...denied] }); }
    if (deny && req.method === 'DELETE') { denied.delete(decodeURIComponent(deny[1])); return send(200, { denied: [...denied] }); }
    if (req.url !== '/check' || req.method !== 'POST') return send(404, { error: 'not found' });
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { error: 'bad secret' });
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        const email = JSON.parse(raw).user?.email;
        send(200, denied.has(email) ? { allowed: false, reason: `${email} is not allowed to use the app.` } : { allowed: true });
    });
}).listen(8190, () => console.log('authz-mock on :8190'));
