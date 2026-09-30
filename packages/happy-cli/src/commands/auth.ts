import axios from 'axios';
import chalk from 'chalk';
import { readCredentials, clearCredentials, clearMachineId, readSettings } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { createInterface } from 'node:readline';
import { stopDaemon, checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import { credentialsLockFile, tokenStore, CREDENTIALS_LOCK_OPTIONS } from '@/api/tokenStore';
import { decodeJwtExpiry } from '@/api/jwt';
import { withFileLock } from '@/utils/fileLock';
import os from 'node:os';

export async function handleAuthCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAuthHelp();
    return;
  }

  switch (subcommand) {
    case 'login':
      await handleAuthLogin(args.slice(1));
      break;
    case 'logout':
      await handleAuthLogout();
      break;
    case 'status':
      await handleAuthStatus();
      break;
    default:
      console.error(chalk.red(`Unknown auth subcommand: ${subcommand}`));
      showAuthHelp();
      process.exit(1);
  }
}

/**
 * Best-effort server-side logout (revokes the device), then clears the local
 * credentials under the credentials lock. Never throws: a failed server call
 * is logged at debug and local logout proceeds regardless.
 */
async function performLogout(): Promise<void> {
  try {
    const accessToken = await tokenStore.getAccessToken();
    await axios.post(`${configuration.serverUrl}/v1/auth/logout`, {}, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 5000,
      // `timeout` alone only bounds the socket after it connects; a
      // black-holed route can hang in DNS/connect well past that. This is a
      // best-effort server-side logout (local logout proceeds regardless),
      // so bound the whole request with a hard deadline too.
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    logger.debug('Server-side logout failed (continuing with local logout):', error instanceof Error ? error.message : String(error));
  }

  await withFileLock(credentialsLockFile(), () => clearCredentials(), CREDENTIALS_LOCK_OPTIONS);
}

function showAuthHelp(): void {
  console.log(`
${chalk.bold('happy auth')} - Authentication management

${chalk.bold('Usage:')}
  happy auth login [--force]    Authenticate with Happy
  happy auth logout             Remove authentication and machine data
  happy auth status             Show authentication status
  happy auth help               Show this help message

${chalk.bold('Options:')}
  --force    Clear credentials, machine ID, and stop daemon before re-auth

${chalk.gray('Sign-in uses your organization\'s identity provider in a browser.')}
`);
}

async function handleAuthLogin(args: string[]): Promise<void> {
  const forceAuth = args.includes('--force') || args.includes('-f');

  if (forceAuth) {
    // As per user's request: "--force-auth will clear credentials, clear machine ID, stop daemon"
    console.log(chalk.yellow('Force authentication requested.'));
    console.log(chalk.gray('This will:'));
    console.log(chalk.gray('  • Clear existing credentials'));
    console.log(chalk.gray('  • Clear machine ID'));
    console.log(chalk.gray('  • Stop daemon if running'));
    console.log(chalk.gray('  • Re-authenticate and register machine\n'));

    // Stop daemon if running
    try {
      logger.debug('Stopping daemon for force auth...');
      await stopDaemon();
      console.log(chalk.gray('✓ Stopped daemon'));
    } catch (error) {
      logger.debug('Daemon was not running or failed to stop:', error);
    }

    // Clear credentials (best-effort server-side logout first)
    await performLogout();
    console.log(chalk.gray('✓ Cleared credentials'));

    // Clear machine ID
    await clearMachineId();
    console.log(chalk.gray('✓ Cleared machine ID'));

    console.log('');
  }

  // Check if already authenticated (if not forcing)
  if (!forceAuth) {
    const existingCreds = await readCredentials();
    const settings = await readSettings();

    if (existingCreds && settings?.machineId) {
      console.log(chalk.green('✓ Already authenticated'));
      console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
      console.log(chalk.gray(`  Host: ${os.hostname()}`));
      console.log(chalk.gray(`  Use 'happy auth login --force' to re-authenticate`));
      return;
    } else if (existingCreds && !settings?.machineId) {
      console.log(chalk.yellow('⚠️  Credentials exist but machine ID is missing'));
      console.log(chalk.gray('  This can happen if --auth flag was used previously'));
      console.log(chalk.gray('  Fixing by setting up machine...\n'));
    }
  }

  // Perform authentication and machine setup
  // "Finally we'll run the auth and setup machine if needed"
  try {
    const result = await authAndSetupMachineIfNeeded();
    console.log(chalk.green('\n✓ Authentication successful'));
    console.log(chalk.gray(`  Machine ID: ${result.machineId}`));
  } catch (error) {
    console.error(chalk.red('Authentication failed:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

async function handleAuthLogout(): Promise<void> {
  // "auth logout will essentially clear the private key that originally came from the phone"
  // Check if authenticated
  const credentials = await readCredentials();
  if (!credentials) {
    console.log(chalk.yellow('Not currently authenticated'));
    return;
  }

  console.log(chalk.blue('This will log you out of Happy'));
  console.log(chalk.yellow('⚠️  You will need to re-authenticate to use Happy again'));

  // Ask for confirmation
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.yellow('Are you sure you want to log out? (y/N): '), resolve);
  });

  rl.close();

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    try {
      // Stop daemon if running
      try {
        await stopDaemon();
        console.log(chalk.gray('Stopped daemon'));
      } catch { }

      // The home is shared with Happy Agent. Logout owns only CLI authentication,
      // never the Agent runtime/database or the local history used for resume.
      await performLogout();
      await clearMachineId();

      console.log(chalk.green('✓ Successfully logged out'));
      console.log(chalk.gray('  Run "happy auth login" to authenticate again'));
    } catch (error) {
      throw new Error(`Failed to logout: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    console.log(chalk.blue('Logout cancelled'));
  }
}

async function handleAuthStatus(): Promise<void> {
  const credentials = await readCredentials();
  const settings = await readSettings();

  console.log(chalk.bold('\nAuthentication Status\n'));

  if (!credentials) {
    console.log(chalk.red('✗ Not authenticated'));
    console.log(chalk.gray('  Run "happy auth login" to authenticate'));
    return;
  }

  console.log(chalk.green('✓ Authenticated'));

  const expiresAt = decodeJwtExpiry(credentials.token);
  console.log(chalk.gray(`  Access token ${expiresAt && expiresAt > Date.now() ? `valid until ${new Date(expiresAt).toLocaleString()}` : 'expired (refreshed automatically on next use)'}`));

  // Machine status
  if (settings?.machineId) {
    console.log(chalk.green('✓ Machine registered'));
    console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
    console.log(chalk.gray(`  Host: ${os.hostname()}`));
  } else {
    console.log(chalk.yellow('⚠️  Machine not registered'));
    console.log(chalk.gray('  Run "happy auth login --force" to fix this'));
  }

  // Data location
  console.log(chalk.gray(`\n  Data directory: ${configuration.happyHomeDir}`));

  // Daemon status
  try {
    const running = await checkIfDaemonRunningAndCleanupStaleState();
    if (running) {
      console.log(chalk.green('✓ Daemon running'));
    } else {
      console.log(chalk.gray('✗ Daemon not running'));
    }
  } catch {
    console.log(chalk.gray('✗ Daemon not running'));
  }
}