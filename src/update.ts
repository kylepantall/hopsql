/**
 * `hopsql update [--check] [--yes]`: compare this install with the latest
 * GitHub release and rerun the installer for it.
 */

import { confirm, isCancel } from '@clack/prompts';
import { getUpdateStatus, installLocation, runUpdate } from './update-check.js';

export async function runUpdateCommand(args: string[], version: string): Promise<void> {
  const unknown = args.find((arg) => !['--check', '--yes', '-y', '--json'].includes(arg));
  if (unknown)
    throw new Error(`Unknown option: ${unknown}. Usage: hopsql update [--check] [--yes] [--json]`);
  const json = args.includes('--json');
  const say = (line: string) => process.stdout.write(line + '\n');
  const status = await getUpdateStatus(version, { maxAgeMs: 0 });
  if (json) say(JSON.stringify(status));
  else if (!status.latest) say(`Hopsql ${version}: no release is published yet.`);
  else if (!status.updateAvailable)
    say(`Hopsql ${version} is up to date (latest release: ${status.latest.version}).`);
  else
    say(
      `Hopsql ${status.latest.version} is available (installed: ${version}).\n${status.latest.url}`
    );
  if (!status.updateAvailable || args.includes('--check')) return;

  const location = installLocation();
  if (!location)
    throw new Error(
      'This copy was not installed by scripts/install.sh or install.ps1; update the checkout with git pull && bun run build.'
    );
  if (!args.includes('--yes') && !args.includes('-y')) {
    if (!process.stdin.isTTY) throw new Error('Rerun with --yes to install without a prompt.');
    const accepted = await confirm({ message: `Install Hopsql ${status.latest!.version}?` });
    if (isCancel(accepted) || !accepted) return;
  }
  await runUpdate(status.latest!.tag, { location });
  say(`Updated to ${status.latest!.version}. Restart MCP clients to load it.`);
}
