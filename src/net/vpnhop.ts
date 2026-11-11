/**
 * vpnhop as a VPN provider: vpnhop owns the profile and its tunnel (one
 * container per profile) and hands out a loopback SOCKS5 proxy, which hopsql
 * dials through exactly as it does a docker VPN's.
 *
 * Tunnels are shared and leased: each `vpnhop proxy` call extends the lease,
 * and the tunnel stops itself when it runs out. hopsql never stops one.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { registerPrivateValue, sanitizeDiagnostic } from '../privacy.js';
import type { SocksProxy } from './socks.js';
import type { CommandRunner } from './vpn.js';

/** The first call may wait for Touch ID and a VPN connect. */
export const VPNHOP_CONNECT_TIMEOUT_MS = 90000;
const LIST_TIMEOUT_MS = 30000;
const DETAIL_LIMIT = 500;

/** vpnhop's own profile name rule. */
export const VPNHOP_PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export interface VpnhopProxy extends SocksProxy {
  /** Epoch ms when the tunnel's lease runs out unless extended. */
  expiresAt: number;
}

export interface VpnhopProfile {
  name: string;
  type?: string;
  description?: string;
  state?: string;
}

/** `$VPNHOP_BIN`, else `~/.local/bin/vpnhop` if present, else `vpnhop` on PATH. */
export function vpnhopPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  exists: (file: string) => boolean = fs.existsSync
): string {
  if (env.VPNHOP_BIN) return env.VPNHOP_BIN;
  const local = path.join(home, '.local', 'bin', 'vpnhop');
  return exists(local) ? local : 'vpnhop';
}

function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  return net.isIPv4(host) && host.startsWith('127.');
}

/** `vpnhop proxy <profile> --json` output; anything off-contract is refused. */
export function parseVpnhopProxy(stdout: string): VpnhopProxy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = undefined;
  }
  const value = (parsed ?? {}) as Record<string, unknown>;
  const { host, port, expiresAt } = value;
  const expires = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (
    typeof host !== 'string' ||
    // vpnhop publishes on loopback only; a remote proxy would leave the machine.
    !isLoopback(host) ||
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535 ||
    Number.isNaN(expires)
  )
    throw new Error('vpnhop returned an unexpected proxy description; update vpnhop to 0.2.0+');
  return { host, port: port as number, expiresAt: expires };
}

/** `vpnhop list --json` output. */
export function parseVpnhopList(stdout: string): VpnhopProfile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed))
    throw new Error('vpnhop did not list its profiles; update vpnhop to 0.2.0+');
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return parsed
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({
      name: p.name as string,
      ...(text(p.type) ? { type: text(p.type) } : {}),
      ...(text(p.description) ? { description: text(p.description) } : {}),
      ...(text(p.state) ? { state: text(p.state) } : {}),
    }));
}

async function run(
  args: string[],
  timeoutMs: number,
  runner: CommandRunner,
  action: string
): Promise<string> {
  const exe = vpnhopPath();
  let result;
  try {
    result = await runner(exe, args, timeoutMs);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    throw new Error(
      missing
        ? 'vpnhop is not installed where hopsql looks; install it or set VPNHOP_BIN'
        : `vpnhop could not be started: ${sanitizeDiagnostic(String(error))}`
    );
  }
  if (result.code === null) throw new Error(`vpnhop did not ${action} before the timeout`);
  if (result.code !== 0) {
    const detail = sanitizeDiagnostic(result.stderr.trim()).slice(0, DETAIL_LIMIT);
    throw new Error(
      `vpnhop failed to ${action} (exit ${result.code})${detail ? `: ${detail}` : ''}`
    );
  }
  return result.stdout;
}

/** Bring the profile's tunnel up if needed and return its SOCKS proxy and lease. */
export async function vpnhopProxy(
  profile: string,
  timeoutMs: number,
  runner: CommandRunner
): Promise<VpnhopProxy> {
  registerPrivateValue(profile);
  return parseVpnhopProxy(await run(['proxy', profile, '--json'], timeoutMs, runner, 'connect'));
}

export async function listVpnhopProfiles(runner: CommandRunner): Promise<VpnhopProfile[]> {
  const profiles = parseVpnhopList(
    await run(['list', '--json'], LIST_TIMEOUT_MS, runner, 'list profiles')
  );
  for (const profile of profiles) registerPrivateValue(profile.name);
  return profiles;
}
