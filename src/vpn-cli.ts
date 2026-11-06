/**
 * `hopsql vpn`: import OpenVPN profiles and say which connections need a VPN.
 * Settings go to the managed overrides file, which running servers re-read.
 */

import {
  loadManagedOverrides,
  managedOverridesPath,
  saveManagedOverrides,
} from './connections-config.js';
import { importOpenVpnProfile, listOpenVpnProfiles, matchProfile } from './net/vpn.js';
import type { ConnectionOverride, DatabaseConnection, VpnConfig } from './types.js';

export const VPN_USAGE =
  'Usage: hopsql vpn list                                List OpenVPN Connect profiles and connections using a VPN\n' +
  '       hopsql vpn import <file.ovpn> [--name <name>]  Import a profile into OpenVPN Connect\n' +
  '       hopsql vpn use <profile> <connection>...       Bring that OpenVPN Connect profile up for these connections\n' +
  '       hopsql vpn clear <connection>...               Stop using a VPN for these connections';

/** Set or remove a connection's VPN in the managed file, keeping its other settings. */
export function setVpn(
  connections: DatabaseConnection[],
  vpn: VpnConfig | undefined,
  file = managedOverridesPath()
): void {
  const overrides = loadManagedOverrides(file);
  for (const connection of connections) {
    // Keep an existing entry keyed by name; the server matches id first, then name.
    const key =
      !overrides[connection.id] && overrides[connection.name] ? connection.name : connection.id;
    const next: ConnectionOverride = { ...overrides[key] };
    if (vpn) next.vpn = vpn;
    else delete next.vpn;
    overrides[key] = next;
  }
  saveManagedOverrides(overrides, file);
}

function pick(connections: DatabaseConnection[], targets: string[]): DatabaseConnection[] {
  if (targets.length === 0) throw new Error(VPN_USAGE);
  const missing = targets.filter((t) => !connections.some((c) => c.id === t || c.name === t));
  if (missing.length)
    throw new Error(`Unknown connections: ${missing.join(', ')}. Nothing changed.`);
  return connections.filter((c) => targets.includes(c.id) || targets.includes(c.name));
}

export async function runVpnCommand(
  args: string[],
  loadConnections: () => Promise<DatabaseConnection[]>,
  say: (line: string) => void = (line) => process.stdout.write(line + '\n')
): Promise<void> {
  const [action, ...rest] = args;
  if (action === 'list' && rest.length === 0) {
    try {
      const profiles = await listOpenVpnProfiles();
      say('OpenVPN Connect profiles:');
      for (const p of profiles) say(`  ${p.id}\t${p.name}`);
      if (profiles.length === 0) say('  (none; import one with "hopsql vpn import <file.ovpn>")');
    } catch (error) {
      say(`OpenVPN Connect: ${error instanceof Error ? error.message : String(error)}`);
    }
    const using = (await loadConnections()).filter((c) => c.vpn);
    say('Connections using a VPN:');
    for (const c of using)
      say(
        `  ${c.id}\t${c.vpn!.provider === 'openvpn-connect' ? c.vpn!.profile : `command: ${c.vpn!.up.join(' ')}`}`
      );
    if (using.length === 0) say('  (none)');
    return;
  }
  if (action === 'import') {
    const [file, ...options] = rest;
    let name: string | undefined;
    if (options.length === 2 && options[0] === '--name') name = options[1];
    else if (options.length) throw new Error(VPN_USAGE);
    if (!file) throw new Error(VPN_USAGE);
    const profile = await importOpenVpnProfile(file, name);
    say(`Imported "${profile.name}" (id ${profile.id}).`);
    say(`Use it with: hopsql vpn use ${profile.id} <connection>...`);
    return;
  }
  if (action === 'use') {
    const [wanted, ...targets] = rest;
    if (!wanted) throw new Error(VPN_USAGE);
    // Checked now so a typo fails here, not on the next query. Stored by id,
    // which survives renaming the profile in the app.
    const profile = matchProfile(await listOpenVpnProfiles(), wanted);
    const chosen = pick(await loadConnections(), targets);
    setVpn(chosen, { provider: 'openvpn-connect', profile: profile.id });
    say(
      `${chosen.length} connection(s) will bring up "${profile.name}" when needed. Running servers apply it on the next call.`
    );
    return;
  }
  if (action === 'clear') {
    const chosen = pick(await loadConnections(), rest);
    setVpn(chosen, undefined);
    say(`${chosen.length} connection(s) no longer use a VPN.`);
    return;
  }
  throw new Error(VPN_USAGE);
}
