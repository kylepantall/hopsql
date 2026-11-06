/**
 * VPNs a connection needs up before it is dialled.
 *
 * A VPN is machine-wide (a tun device, routes, root), unlike the
 * per-connection SSH and SSM hops, so hopsql drives the user's own client
 * rather than carrying one:
 *
 *  - `openvpn-connect`: the OpenVPN Connect app's command line, with a profile
 *    already imported into it (see `hopsql vpn import`).
 *  - `command`: argv the user supplies for any other client (Tunnelblick via
 *    osascript, wg-quick, tailscale, ...). Never run through a shell.
 *
 * No client answers "is it up" portably, so the test is whether the first host
 * the connection dials accepts a TCP connection, unless a `check` command is
 * configured.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { registerPrivateValue, sanitizeDiagnostic } from '../privacy.js';
import type { DatabaseConnection, VpnConfig } from '../types.js';
import { socksAvailable, type SocksProxy } from './socks.js';
import { containerName, DockerVpn } from './vpn-docker.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 60000;
const DOCKER_CONNECT_TIMEOUT_MS = 120000;
const PROBE_TIMEOUT_MS = 1500;
const POLL_INTERVAL_MS = 1000;
/** A VPN seen up is not probed again for this long. */
const UP_CACHE_MS = 30000;
const COMMAND_TIMEOUT_MS = 30000;
const OUTPUT_LIMIT = 1_000_000;

export interface ProbeTarget {
  host: string;
  port: number;
}

export interface CommandResult {
  /** Null when the command was still running at the timeout and was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run to completion (or kill at the timeout), capturing output. */
export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
  /** Written to the command's stdin. */
  input?: string
) => Promise<CommandResult>;

/** A started `up` command, which may be a one-shot or a long-running client. */
export interface Launched {
  /** The exit status once it has exited; undefined while it still runs. */
  exitCode(): number | null | undefined;
  stderr(): string;
  /** Stop listening to it; a still-running client is left running. */
  release(): void;
}

export type Launcher = (command: string, args: string[]) => Launched;
export type Probe = (target: ProbeTarget, timeoutMs: number) => Promise<boolean>;

function append(current: string, chunk: Buffer): string {
  return current.length >= OUTPUT_LIMIT ? current : current + chunk.toString('utf8');
}

export const runCommand: CommandRunner = (command, args, timeoutMs, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout!.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr!.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr });
    });
  });

/**
 * Start detached and never kill it: launching OpenVPN Connect when it is not
 * running makes this process the app itself, and a client like `openvpn`
 * stays in the foreground for as long as the VPN is up.
 */
export const launchCommand: Launcher = (command, args) => {
  const child = spawn(command, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let code: number | null | undefined;
  let stderr = '';
  let spawnError: Error | undefined;
  child.stderr?.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
  child.once('error', (error) => {
    spawnError = error;
    code = 127;
  });
  child.once('exit', (exitCode) => {
    code = exitCode ?? 1;
  });
  return {
    exitCode: () => code,
    stderr: () => (spawnError ? spawnError.message : stderr),
    release: () => {
      child.stderr?.destroy();
      child.unref();
    },
  };
};

export const tcpProbe: Probe = (target, timeoutMs) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

/**
 * The first host the connection dials, which is what the VPN must reach: the
 * outermost SSH hop, else the database. SSM dials AWS's public endpoints, so
 * it has none.
 */
export function probeTarget(
  connection: DatabaseConnection,
  defaultPort: number
): ProbeTarget | null {
  if (connection.ssm) return null;
  const ssh = connection.sshTunnel;
  if (ssh?.enabled) {
    const first = ssh.jumpHosts?.[0] ?? ssh;
    return first.host ? { host: first.host, port: first.port || 22 } : null;
  }
  if (!connection.host) return null;
  return { host: connection.host, port: connection.port || defaultPort };
}

// --- OpenVPN Connect -------------------------------------------------------

export interface OpenVpnProfile {
  id: string;
  name: string;
}

/** The OpenVPN Connect executable; `HOPSQL_OPENVPN_CONNECT` overrides it. */
export function openVpnConnectPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (env.HOPSQL_OPENVPN_CONNECT) return env.HOPSQL_OPENVPN_CONNECT;
  if (platform === 'darwin')
    return '/Applications/OpenVPN Connect/OpenVPN Connect.app/Contents/MacOS/OpenVPN Connect';
  if (platform === 'win32')
    return path.win32.join(
      env.ProgramFiles || 'C:\\Program Files',
      'OpenVPN Connect',
      'OpenVPNConnect.exe'
    );
  throw new Error(
    'OpenVPN Connect has no command line on this platform; use the "command" VPN provider instead'
  );
}

function installedOpenVpnConnect(): string {
  const exe = openVpnConnectPath();
  if (!fs.existsSync(exe))
    throw new Error(
      'OpenVPN Connect is not installed where hopsql looks; set HOPSQL_OPENVPN_CONNECT to its executable'
    );
  return exe;
}

/** Where OpenVPN Connect keeps an imported profile's .ovpn file. */
export function openVpnConnectProfileFile(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const base =
    platform === 'win32'
      ? path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'OpenVPN Connect')
      : path.join(os.homedir(), 'Library', 'Application Support', 'OpenVPN Connect');
  return path.join(base, 'profiles', `${id}.ovpn`);
}

/** `--list-profiles` prints a JSON array; anything else means an older app. */
export function parseProfileList(stdout: string): OpenVpnProfile[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  let parsed: unknown;
  try {
    parsed = start === -1 ? undefined : JSON.parse(stdout.slice(start, end + 1));
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed))
    throw new Error('OpenVPN Connect did not list its profiles; it needs version 3.3 or later');
  return parsed
    .filter((p) => p && (typeof p.id === 'string' || typeof p.id === 'number'))
    .map((p) => ({ id: String(p.id), name: typeof p.name === 'string' ? p.name : String(p.id) }));
}

export async function listOpenVpnProfiles(
  runner: CommandRunner = runCommand
): Promise<OpenVpnProfile[]> {
  const result = await runner(installedOpenVpnConnect(), ['--list-profiles'], COMMAND_TIMEOUT_MS);
  const profiles = parseProfileList(result.stdout);
  for (const profile of profiles) registerPrivateValue(profile.name);
  return profiles;
}

/** By id, then exact name, then a name that matches case-insensitively or uniquely contains it. */
export function matchProfile(profiles: OpenVpnProfile[], wanted: string): OpenVpnProfile {
  const lower = wanted.toLowerCase();
  const found =
    profiles.find((p) => p.id === wanted) ??
    profiles.find((p) => p.name === wanted) ??
    profiles.find((p) => p.name.toLowerCase() === lower);
  if (found) return found;
  const partial = profiles.filter((p) => p.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  throw new Error(
    partial.length > 1
      ? `VPN profile "${wanted}" matches ${partial.length} OpenVPN Connect profiles; use its id from "hopsql vpn list"`
      : `No OpenVPN Connect profile matches "${wanted}"; import it with "hopsql vpn import <file.ovpn>"`
  );
}

/**
 * Import a profile file into OpenVPN Connect and return the new profile.
 * Credentials are never passed on the command line: use an autologin profile,
 * or save them in the app once.
 */
export async function importOpenVpnProfile(
  file: string,
  name: string | undefined,
  runner: CommandRunner = runCommand
): Promise<OpenVpnProfile> {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
    throw new Error('VPN profile file not found');
  if (name !== undefined && (!name.trim() || /[\0\r\n]/.test(name) || name.startsWith('-')))
    throw new Error('Invalid profile name');
  const before = new Set((await listOpenVpnProfiles(runner)).map((p) => p.id));
  const args = [`--import-profile=${absolute}`, ...(name ? [`--name=${name}`] : [])];
  const result = await runner(installedOpenVpnConnect(), args, COMMAND_TIMEOUT_MS);
  const added = (await listOpenVpnProfiles(runner)).filter((p) => !before.has(p.id));
  if (added.length === 0)
    throw new Error(
      `OpenVPN Connect did not import the profile${result.stderr.trim() ? `: ${sanitizeDiagnostic(result.stderr.trim())}` : ''}`
    );
  return added[0];
}

// --- Manager -----------------------------------------------------------------

type HostVpn = Exclude<VpnConfig, { provider: 'docker' }>;
type DockerVpnConfig = Extract<VpnConfig, { provider: 'docker' }>;

function vpnKey(vpn: HostVpn): string {
  return vpn.provider === 'openvpn-connect'
    ? `openvpn-connect:${vpn.profile}`
    : `command:${JSON.stringify(vpn.up)}`;
}

function describe(vpn: HostVpn): string {
  return vpn.provider === 'openvpn-connect'
    ? `OpenVPN Connect profile "${vpn.profile}"`
    : `VPN command "${vpn.up[0]}"`;
}

function expandHome(file: string): string {
  return file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
}

/** True for a VPN only hopsql's connections use, dialled through its SOCKS proxy. */
export function usesVpnProxy(connection: DatabaseConnection): boolean {
  return connection.vpn?.provider === 'docker';
}

export interface VpnManagerOptions {
  runner?: CommandRunner;
  launcher?: Launcher;
  probe?: Probe;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  docker?: DockerVpn;
  socksReady?: (proxy: SocksProxy) => Promise<boolean>;
}

export class VpnManager {
  private readonly runner: CommandRunner;
  private readonly launcher: Launcher;
  private readonly probe: Probe;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private pending = new Map<string, Promise<void>>();
  private upUntil = new Map<string, number>();
  /** VPNs this process brought up, to take down again on exit. */
  private started = new Map<string, HostVpn>();
  private readonly docker: DockerVpn;
  private readonly socksReady: (proxy: SocksProxy) => Promise<boolean>;
  private proxies = new Map<string, { proxy: SocksProxy; checkedUntil: number }>();
  private pendingProxies = new Map<string, Promise<SocksProxy>>();
  /** Containers this process started, removed on exit. */
  private containers = new Set<string>();
  private debug = false;

  constructor(options: VpnManagerOptions = {}) {
    this.runner = options.runner ?? runCommand;
    this.launcher = options.launcher ?? launchCommand;
    this.probe = options.probe ?? tcpProbe;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.docker = options.docker ?? new DockerVpn(this.runner);
    this.socksReady = options.socksReady ?? ((proxy) => socksAvailable(proxy, PROBE_TIMEOUT_MS));
  }

  setDebug(debug: boolean): void {
    this.debug = debug;
  }

  private log(message: string, context: Record<string, unknown>): void {
    if (this.debug) console.error(`[Vpn] ${message}`, sanitizeDiagnostic(JSON.stringify(context)));
  }

  /** Bring the connection's VPN up if it is not already; a no-op without one. */
  async ensure(connection: DatabaseConnection, defaultPort: number): Promise<void> {
    const vpn = connection.vpn;
    if (!vpn) return;
    if (vpn.provider === 'docker') return void (await this.proxyFor(connection));
    if (vpn.provider === 'openvpn-connect') registerPrivateValue(vpn.profile);
    const key = vpnKey(vpn);
    if ((this.upUntil.get(key) ?? 0) > this.now()) return;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const work = this.bringUp(key, vpn, probeTarget(connection, defaultPort)).finally(() =>
      this.pending.delete(key)
    );
    this.pending.set(key, work);
    return work;
  }

  private async isUp(vpn: HostVpn, target: ProbeTarget | null): Promise<boolean> {
    if (vpn.provider === 'command' && vpn.check) {
      const result = await this.runner(vpn.check[0], vpn.check.slice(1), COMMAND_TIMEOUT_MS).catch(
        () => undefined
      );
      return result?.code === 0;
    }
    return target ? this.probe(target, PROBE_TIMEOUT_MS) : false;
  }

  private async start(vpn: HostVpn): Promise<Launched> {
    if (vpn.provider === 'command') return this.launcher(vpn.up[0], vpn.up.slice(1));
    const profile = matchProfile(await listOpenVpnProfiles(this.runner), vpn.profile);
    return this.launcher(installedOpenVpnConnect(), [`--connect-shortcut=${profile.id}`]);
  }

  private async bringUp(key: string, vpn: HostVpn, target: ProbeTarget | null): Promise<void> {
    const markUp = () => this.upUntil.set(key, this.now() + UP_CACHE_MS);
    const checkable = target !== null || (vpn.provider === 'command' && vpn.check !== undefined);
    if (await this.isUp(vpn, target)) return void markUp();
    // Nothing to test against: trust an earlier start by this process.
    if (!checkable && this.started.has(key)) return void markUp();

    this.log('connecting', { provider: vpn.provider });
    const deadline = this.now() + (vpn.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    const launched = await this.start(vpn);
    if (vpn.disconnectOnExit !== false) this.started.set(key, vpn);
    const failed = () => {
      const code = launched.exitCode();
      // A client exiting 0 may have handed off to a daemon; keep waiting for it.
      if (code === undefined || code === 0) return undefined;
      const detail = sanitizeDiagnostic(launched.stderr().trim());
      return new Error(
        `${describe(vpn)} failed to start (exit ${code ?? 'signal'})${detail ? `: ${detail}` : ''}`
      );
    };
    try {
      for (;;) {
        const error = failed();
        if (error) throw error;
        if (checkable ? await this.isUp(vpn, target) : launched.exitCode() === 0) break;
        if (this.now() >= deadline)
          throw new Error(
            checkable
              ? `${describe(vpn)} was started but the connection's host is still unreachable. The VPN may need you to sign in, or the database itself may be down.`
              : `${describe(vpn)} did not finish before the timeout`
          );
        await this.sleep(this.pollIntervalMs);
      }
    } finally {
      launched.release();
    }
    this.log('connected', { provider: vpn.provider });
    markUp();
  }

  /** The .ovpn file a docker VPN runs: its own path, or an OpenVPN Connect profile's. */
  private async dockerProfileFile(vpn: DockerVpnConfig): Promise<string> {
    if (vpn.config) {
      const file = expandHome(vpn.config);
      if (!fs.existsSync(file)) throw new Error('The VPN profile file (vpn.config) does not exist');
      return file;
    }
    const wanted = vpn.profile!;
    registerPrivateValue(wanted);
    const direct = openVpnConnectProfileFile(wanted);
    if (/^\d+$/.test(wanted) && fs.existsSync(direct)) return direct;
    const profile = matchProfile(await listOpenVpnProfiles(this.runner), wanted);
    const file = openVpnConnectProfileFile(profile.id);
    if (!fs.existsSync(file))
      throw new Error(`OpenVPN Connect has no stored file for profile ${profile.id}`);
    return file;
  }

  /**
   * The SOCKS proxy of the connection's VPN container, starting the container
   * if it is not running. A container another server started for the same
   * profile is reused, and left running on exit.
   */
  async proxyFor(connection: DatabaseConnection): Promise<SocksProxy> {
    const vpn = connection.vpn;
    if (vpn?.provider !== 'docker') throw new Error('Connection has no docker VPN');
    if (connection.ssm)
      throw new Error(
        `Connection "${connection.name}" uses SSM, which reaches AWS directly; a docker VPN cannot carry it`
      );
    const file = await this.dockerProfileFile(vpn);
    const name = containerName(file);
    const cached = this.proxies.get(name);
    if (cached && cached.checkedUntil > this.now()) return cached.proxy;
    const inFlight = this.pendingProxies.get(name);
    if (inFlight) return inFlight;
    const work = this.startContainer(name, file, vpn).finally(() =>
      this.pendingProxies.delete(name)
    );
    this.pendingProxies.set(name, work);
    return work;
  }

  private async startContainer(
    name: string,
    file: string,
    vpn: DockerVpnConfig
  ): Promise<SocksProxy> {
    await this.docker.assertAvailable();
    let startedHere = false;
    if (!(await this.docker.running(name))) {
      this.proxies.delete(name);
      this.log('starting container', { name });
      await this.docker.ensureImage();
      await this.docker.start(name, file);
      startedHere = true;
      if (vpn.disconnectOnExit !== false) this.containers.add(name);
    }
    try {
      return await this.awaitProxy(name, vpn);
    } catch (error) {
      // A container that never connected is not left retrying in the background.
      if (startedHere) {
        this.containers.delete(name);
        await this.docker.remove(name).catch(() => {});
      }
      throw error;
    }
  }

  private async awaitProxy(name: string, vpn: DockerVpnConfig): Promise<SocksProxy> {
    // Longer by default: openvpn backs off between attempts (16s, 32s, ...).
    const deadline = this.now() + (vpn.connectTimeoutMs ?? DOCKER_CONNECT_TIMEOUT_MS);
    for (;;) {
      if (!(await this.docker.running(name)))
        throw new Error(`The VPN container stopped: ${await this.docker.failure(name)}`);
      const proxy = await this.docker.proxy(name);
      if (proxy && (await this.socksReady(proxy))) {
        this.proxies.set(name, { proxy, checkedUntil: this.now() + UP_CACHE_MS });
        this.log('container ready', { name });
        return proxy;
      }
      if (this.now() >= deadline)
        throw new Error(
          `The VPN container did not connect before the timeout: ${await this.docker.failure(name)}`
        );
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** Take down every VPN this process brought up. Failures are logged, not thrown. */
  async disconnectAll(): Promise<void> {
    const started = [...this.started.values()];
    this.started.clear();
    this.upUntil.clear();
    const containers = [...this.containers];
    this.containers.clear();
    this.proxies.clear();
    for (const name of containers)
      await this.docker
        .remove(name)
        .catch((error) => this.log('container removal failed', { name, error: String(error) }));
    for (const vpn of started) {
      try {
        if (vpn.provider === 'openvpn-connect')
          await this.runner(
            installedOpenVpnConnect(),
            ['--disconnect-shortcut'],
            COMMAND_TIMEOUT_MS
          );
        else if (vpn.down) await this.runner(vpn.down[0], vpn.down.slice(1), COMMAND_TIMEOUT_MS);
        this.log('disconnected', { provider: vpn.provider });
      } catch (error) {
        this.log('disconnect failed', { provider: vpn.provider, error: String(error) });
      }
    }
  }
}

export const vpnManager = new VpnManager();
