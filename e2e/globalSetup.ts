const ISSUER = process.env.HAPPY_OIDC_ISSUER ?? 'http://localhost:8180';
const SERVER = process.env.HAPPY_SERVER_URL ?? 'http://localhost:3005';
const WEBAPP = process.env.HAPPY_WEBAPP_URL ?? 'http://localhost:8080';

export default async function globalSetup(): Promise<void> {
    const deadline = Date.now() + 180_000;
    for (const url of [`${ISSUER}/.well-known/openid-configuration`, `${SERVER}/health`, `${WEBAPP}/`]) {
        for (;;) {
            try {
                const response = await fetch(url);
                if (response.ok) break;
            } catch {
                // not up yet
            }
            if (Date.now() > deadline) {
                throw new Error(`${url} is not reachable. Start the stack: docker compose --profile e2e up -d --build`);
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}
