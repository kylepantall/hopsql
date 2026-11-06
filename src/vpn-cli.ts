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
import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionOverride, DatabaseConnection, VpnConfig } from './types.js';

export const VPN_USAGE =
  'Usage: hopsql vpn list                                List OpenVPN Connect profiles and connections using a VPN\n' +
  '       hopsql vpn import <file.ovpn> [--name <name>]  Import a profile into OpenVPN Connect\n' +
  '       hopsql vpn use <profile> <connection>... [--docker]\n' +
  '                                                      Bring that profile up for these connections; --docker runs it\n' +
  '                                                      in a container so only hopsql uses the VPN. <profile> may be\n' +
  '                                                      an OpenVPN Connect profile, or an .ovpn file with --docker\n' +
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

function describeVpn(vpn: VpnConfig): string {
  if (vpn.provider === 'openvpn-connect') return `OpenVPN Connect: ${vpn.profile}`;
  if (vpn.provider === 'docker') return `docker: ${vpn.profile ?? vpn.config}`;
  return `command: ${vpn.up.join(' ')}`;
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
    for (const c of using) say(`  ${c.id}\t${describeVpn(c.vpn!)}`);
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
    const docker = rest.includes('--docker');
    const [wanted, ...targets] = rest.filter((arg) => arg !== '--docker');
    if (!wanted) throw new Error(VPN_USAGE);
    const file = /\.(ovpn|conf)$/i.test(wanted) ? path.resolve(wanted) : undefined;
    if (file && !docker) throw new Error('An .ovpn file needs --docker; or import it first');
    if (file && !fs.existsSync(file)) throw new Error('VPN profile file not found');
    // Checked now so a typo fails here, not on the next query. Stored by id,
    // which survives renaming the profile in the app.
    const profile = file ? undefined : matchProfile(await listOpenVpnProfiles(), wanted);
    const chosen = pick(await loadConnections(), targets);
    const vpn: VpnConfig = !docker
      ? { provider: 'openvpn-connect', profile: profile!.id }
      : file
        ? { provider: 'docker', config: file }
        : { provider: 'docker', profile: profile!.id };
    setVpn(chosen, vpn);
    say(
      `${chosen.length} connection(s) will bring up "${profile?.name ?? path.basename(file!)}"${docker ? ' in a container' : ''} when needed. Running servers apply it on the next call.`
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
