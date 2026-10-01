/**
 * This build has no built-in server: without HAPPY_SERVER_URL (or serverUrl in
 * settings.json) the CLI refuses to start instead of contacting an upstream host.
 */
export function missingServerUrlMessage(settingsFile: string): string {
    return [
        `HAPPY_SERVER_URL is not set, and ${settingsFile} has no "serverUrl".`,
        'This build has no default server. Point it at your Happy server, for example:',
        '  export HAPPY_SERVER_URL=https://happy.example.com',
    ].join('\n');
}

export class MissingServerUrlError extends Error {
    constructor(settingsFile: string) {
        super(missingServerUrlMessage(settingsFile));
        this.name = 'MissingServerUrlError';
    }
}

const HELP_OR_VERSION = new Set(['--help', '-h', '--version', '-v']);
const LOCAL_COMMANDS = new Set(['doctor', 'bye']);
const LOCAL_DAEMON_SUBCOMMANDS = new Set(['status', 'stop', 'list', 'stop-session', 'logs', 'uninstall']);

/** False for help/version output and purely local commands; true for everything that talks to the server. */
export function commandNeedsServerUrl(args: readonly string[]): boolean {
    if (args.some((arg) => HELP_OR_VERSION.has(arg))) {
        return false;
    }
    const [subcommand, daemonSubcommand] = args;
    if (subcommand !== undefined && LOCAL_COMMANDS.has(subcommand)) {
        return false;
    }
    if (subcommand === 'daemon' && (daemonSubcommand === undefined || LOCAL_DAEMON_SUBCOMMANDS.has(daemonSubcommand))) {
        return false;
    }
    return true;
}
