import { homedir } from 'node:os';
import { join } from 'node:path';

export type Config = {
    serverUrl: string;
    homeDir: string;
    credentialPath: string;
};

export function loadConfig(): Config {
    const serverUrl = (process.env.HAPPY_SERVER_URL ?? 'https://api.cluster-fluster.com').replace(/\/+$/, '');
    // Expand a leading `~` the same way happy-cli's `configuration.ts` does, so
    // `HAPPY_HOME_DIR=~/x` resolves to the same `agent.key` path in both.
    const homeDir = process.env.HAPPY_HOME_DIR
        ? process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
        : join(homedir(), '.happy');
    const credentialPath = join(homeDir, 'agent.key');
    return { serverUrl, homeDir, credentialPath };
}
