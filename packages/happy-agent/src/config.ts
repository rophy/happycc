import { homedir } from 'node:os';
import { join } from 'node:path';

export type Config = {
    serverUrl: string;
    homeDir: string;
    credentialPath: string;
};

export const MISSING_SERVER_URL_MESSAGE =
    'HAPPY_SERVER_URL is not set. This build has no default server; point it at your Happy server, ' +
    'for example: export HAPPY_SERVER_URL=https://happy.example.com';

export function loadConfig(): Config {
    const rawServerUrl = process.env.HAPPY_SERVER_URL?.trim();
    if (!rawServerUrl) {
        throw new Error(MISSING_SERVER_URL_MESSAGE);
    }
    const serverUrl = rawServerUrl.replace(/\/+$/, '');
    // Expand a leading `~` the same way happy-cli's `configuration.ts` does, so
    // `HAPPY_HOME_DIR=~/x` resolves to the same `agent.key` path in both.
    const homeDir = process.env.HAPPY_HOME_DIR
        ? process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
        : join(homedir(), '.happy');
    const credentialPath = join(homeDir, 'agent.key');
    return { serverUrl, homeDir, credentialPath };
}
