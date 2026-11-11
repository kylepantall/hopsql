import { registerConnectionPrivacy, sanitizeDiagnostic } from '../privacy.js';
/**
 * SSH tunnels for connections that DBeaver reaches through one.
 *
 * A tunneled connection records its target as it looks *from the SSH server* -
 * usually `localhost` - and keeps the real jump host under
 * `handlers.ssh_tunnel`. DBeaver opens a local forward and points the driver
 * at it. Reading the target host without opening that forward is how such a
 * connection ends up talking to whatever happens to be on the same port of the
 * local machine, so this module reproduces the forward instead.
 */

import fs from 'fs';
import { booleanSetting } from '../runtime-config.js';
import net from 'net';
import os from 'os';
import path from 'path';
import type { DatabaseConnection, SshTunnelConfig, SsmConfig } from '../types.js';
import {
  appendKnownHost,
  keyFingerprint,
  knownHostsPath,
  loadKnownHosts,
  verifyHostKey,
} from './known-hosts.js';
import { discoverAgentSocket } from './ssh-agent.js';
import {
  childStream,
  pickLocalPort,
  resolveSsmTarget,
  ssmArgs,
  startSsmPortForward,
  startSsmSession,
  type SsmSession,
} from './ssm.js';
import { socksConnect, type SocksProxy } from './socks.js';
import { usesVpnProxy, vpnManager } from './vpn.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 20000;

export interface TunnelEndpoint {
  host: string;
  port: number;
  /**
   * Bumped each time the tunnel is (re)established, so anything holding
   * connections through an earlier one - a pool - can tell they are dead even
   * when the local port was rebound unchanged.
   */
  generation?: number;
}

interface ActiveTunnel extends TunnelEndpoint {
  alive: boolean;
  /** The VPN proxy it dials through; a different one means the tunnel is stale. */
  via?: string;
  close: () => Promise<void>;
}

/** True when the recorded host/port are reached through a local forward. */
export function isTunneled(connection: DatabaseConnection): boolean {
  return (
    connection.sshTunnel?.enabled === true ||
    connection.ssm !== undefined ||
    usesVpnProxy(connection)
  );
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  // Driver spellings of the same: mysql2, tedious/mssql, node-oracledb.
  'PROTOCOL_CONNECTION_LOST',
  'ESOCKET',
  'ECONNCLOSED',
  'NJS-500',
  'NJS-501',
  'NJS-503',
]);
const CONNECTION_ERROR_TEXT =
  /Connection terminated|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|(channel|connection) (was )?closed|Not connected|No response from server/i;

/**
 * Whether a query failed because the transport went away rather than because
 * of anything the database said - the case a reopened tunnel can fix.
 */
export function isConnectionLevelError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current !== 'object') return CONNECTION_ERROR_TEXT.test(String(current));
    const { code, message, cause } = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true;
    if (typeof message === 'string' && CONNECTION_ERROR_TEXT.test(message)) return true;
    current = cause;
  }
  return false;
}

/** Expand a leading `~`, which DBeaver stores verbatim in key paths. */
export function expandHome(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Decide how to authenticate to the SSH server.
 *
 * DBeaver records an explicit `authType`, but older configs and hand-edited
 * ones omit it, so fall back to whatever material is actually present.
 */
export function resolveAuthType(config: SshTunnelConfig): 'AGENT' | 'PASSWORD' | 'PUBLIC_KEY' {
  const declared = (config.authType ?? '').toUpperCase();
  if (declared === 'AGENT' || declared === 'PASSWORD' || declared === 'PUBLIC_KEY') {
    return declared;
  }
  if (config.privateKeyPath) {
    return 'PUBLIC_KEY';
  }
  if (config.password) {
    return 'PASSWORD';
  }
  return 'AGENT';
}

/** Build the ssh2 connect options, failing loudly on missing material. */
export function buildConnectOptions(
  config: SshTunnelConfig,
  connectionName: string
): Record<string, unknown> {
  const authType = resolveAuthType(config);

  const base: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    username: config.user,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    readyTimeout: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  };

  if (!config.user) {
    throw new Error(
      `SSH tunnel for "${connectionName}" has no username. Set the SSH user on the ` +
        `connection's SSH tab, or save its credentials so they can be read from the workspace.`
    );
  }

  if (authType === 'PASSWORD') {
    if (!config.password) {
      throw new Error(
        `SSH tunnel for "${connectionName}" uses password authentication but no password is ` +
          `stored. Enable "Save password" on the connection's SSH tab, or switch it to key or ` +
          `agent authentication.`
      );
    }
    return { ...base, password: config.password };
  }

  // Looked up for key auth too: ssh2 tries the key first and then the agent's
  // identities, which is what OpenSSH does with an IdentityFile and an agent.
  const agent = discoverAgentSocket(config.host);

  if (authType === 'PUBLIC_KEY') {
    if (!config.privateKeyPath) {
      if (agent) return { ...base, agent };
      throw new Error(
        `SSH tunnel for "${connectionName}" uses public key authentication but records no ` +
          `private key path.`
      );
    }
    const keyPath = expandHome(config.privateKeyPath);
    let privateKey: Buffer;
    try {
      privateKey = fs.readFileSync(keyPath);
    } catch (error) {
      // A key that lives only in the agent (1Password, a hardware key) is
      // routinely recorded by path in DBeaver without the file existing.
      if (agent) return { ...base, agent };
      throw new Error(
        `SSH tunnel for "${connectionName}" could not read its private key at "${keyPath}": ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {
      ...base,
      privateKey,
      ...(config.passphrase ? { passphrase: config.passphrase } : {}),
      ...(agent ? { agent } : {}),
    };
  }

  // AGENT: DBeaver's default, and the only one that works with a hardware key
  // or an unlocked SSO agent.
  if (!agent) {
    throw new Error(
      `SSH tunnel for "${connectionName}" is set to agent authentication but no SSH agent was ` +
        `found: HOPSQL_SSH_AUTH_SOCK and SSH_AUTH_SOCK are unset or missing, ~/.ssh/config has ` +
        `no usable IdentityAgent, and no 1Password agent socket exists. MCP servers are launched ` +
        `by the client, which often does not inherit your shell environment - set ` +
        `HOPSQL_SSH_AUTH_SOCK in the server's env config, or switch the connection to key ` +
        `authentication.`
    );
  }
  return { ...base, agent };
}

/** An SSH host that is not in known_hosts, refused under strict checking. */
export class UnknownHostKeyError extends Error {
  constructor(
    message: string,
    readonly host: string,
    readonly port: number,
    readonly keyType: string,
    readonly key: Buffer
  ) {
    super(message);
  }
}

export interface HostKeyQuestion {
  connectionName: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

/** Asks the user whether to trust an unknown host key; true records it. */
export type HostKeyPrompt = (question: HostKeyQuestion) => Promise<boolean>;

/** Each hop of a chain can be unknown, so allow one approval per plausible hop. */
const MAX_HOST_KEY_APPROVALS = 8;

export class SshTunnelManager {
  private hostKeyPrompt: HostKeyPrompt | undefined;
  /** One question per host key, however many connections hit it at once. */
  private hostKeyQuestions = new Map<string, Promise<boolean>>();
  private tunnels = new Map<string, ActiveTunnel>();
  private pending = new Map<string, Promise<ActiveTunnel>>();
  /** The last local port per connection, rebound on reconnect when free. */
  private lastPorts = new Map<string, number>();
  private generations = new Map<string, number>();
  private debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
  }

  /**
   * The tunnel manager is shared by the direct-query and pooled paths, so it is
   * a singleton constructed before the server has parsed its own options.
   */
  setDebug(debug: boolean): void {
    this.debug = debug;
    vpnManager.setDebug(debug);
  }

  /** Set once the MCP client says it can ask the user; unset, unknown hosts are refused. */
  setHostKeyPrompt(prompt: HostKeyPrompt | undefined): void {
    this.hostKeyPrompt = prompt;
  }

  /**
   * Open the tunnel, asking the user about each unknown host key on the way.
   * An approved key is recorded and the chain is dialled again from the start.
   */
  private async openWithApproval(
    connection: DatabaseConnection,
    config: SshTunnelConfig | undefined,
    destHost: string,
    destPort: number,
    preferredPort?: number,
    proxy?: SocksProxy
  ): Promise<ActiveTunnel> {
    for (let approvals = 0; ; approvals += 1) {
      try {
        return await this.open(connection, config, destHost, destPort, preferredPort, proxy);
      } catch (error) {
        const prompt = this.hostKeyPrompt;
        if (
          !(error instanceof UnknownHostKeyError) ||
          !prompt ||
          approvals >= MAX_HOST_KEY_APPROVALS
        )
          throw error;
        const fingerprint = keyFingerprint(error.key);
        const id = `${error.host}:${error.port}:${error.keyType}:${fingerprint}`;
        let question = this.hostKeyQuestions.get(id);
        if (!question) {
          question = prompt({
            connectionName: connection.name,
            host: error.host,
            port: error.port,
            keyType: error.keyType,
            fingerprint,
          })
            .then((trusted) => {
              if (trusted) appendKnownHost(error.host, error.port, error.keyType, error.key);
              return trusted;
            })
            .finally(() => this.hostKeyQuestions.delete(id));
          this.hostKeyQuestions.set(id, question);
        }
        if (!(await question)) throw error;
        this.log(`Recorded approved host key for ${error.host}:${error.port} (${fingerprint})`);
      }
    }
  }

  private log(message: string): void {
    if (this.debug) {
      console.error(`[SshTunnel] ${sanitizeDiagnostic(message)}`);
    }
  }

  /**
   * Return the local endpoint to connect to for this connection, opening the
   * tunnel first if it is not already up. Connections without a tunnel are
   * returned unchanged.
   */
  async resolveEndpoint(
    connection: DatabaseConnection,
    defaultPort: number
  ): Promise<TunnelEndpoint | null> {
    registerConnectionPrivacy(connection);
    // Every path that dials a connection comes through here, tunneled or not.
    // A docker or vpnhop VPN is dialled through its proxy; for a host VPN, a live tunnel
    // proves the VPN under it is still up.
    let proxy: SocksProxy | undefined;
    if (usesVpnProxy(connection)) proxy = await vpnManager.proxyFor(connection);
    else if (connection.vpn && !this.tunnels.get(connection.id)?.alive)
      await vpnManager.ensure(connection, defaultPort);
    const config = connection.sshTunnel;
    const ssm = connection.ssm;
    if (!ssm && !config?.enabled && !proxy) {
      return null;
    }
    const via = proxy ? `${proxy.host}:${proxy.port}` : undefined;

    const key = connection.id;
    const endpoint = (tunnel: ActiveTunnel): TunnelEndpoint => ({
      host: tunnel.host,
      port: tunnel.port,
      generation: tunnel.generation,
    });
    const existing = this.tunnels.get(key);
    if (existing?.alive && existing.via === via) {
      return endpoint(existing);
    }

    const inFlight = this.pending.get(key);
    if (inFlight) {
      return endpoint(await inFlight);
    }

    // A port-forward's remote endpoint replaces DBeaver's, which often points
    // at a localhost forward a script used to provide.
    const forward = ssm?.mode === 'port-forward' ? ssm : undefined;
    const destHost = forward?.remoteHost || connection.host || 'localhost';
    const destPort = forward?.remotePort || connection.port || defaultPort;
    // A dead tunnel is replaced on the port it had, so anything that cached
    // the endpoint keeps working; the generation still tells pools to rebuild.
    const preferredPort = this.lastPorts.get(key);
    if (existing) this.tunnels.delete(key);

    const creation = (async () => {
      // Release the old listener first so its port can be rebound.
      if (existing) await existing.close().catch(() => {});
      if (ssm?.mode === 'port-forward')
        return this.openPortForward(connection, ssm, destHost, destPort, preferredPort);
      if (proxy && !config?.enabled)
        return this.openSocksForward(connection, proxy, destHost, destPort, preferredPort);
      return this.openWithApproval(connection, config, destHost, destPort, preferredPort, proxy);
    })();
    this.pending.set(key, creation);
    try {
      const tunnel = await creation.catch((error: unknown) => {
        // A dead vpnhop proxy (tunnel restarted elsewhere) is asked for again next time.
        if (proxy) vpnManager.forgetProxy(connection);
        throw error;
      });
      tunnel.via = via;
      tunnel.generation = (this.generations.get(key) ?? 0) + 1;
      this.generations.set(key, tunnel.generation);
      this.lastPorts.set(key, tunnel.port);
      this.tunnels.set(key, tunnel);
      return endpoint(tunnel);
    } finally {
      this.pending.delete(key);
    }
  }

  /**
   * A loopback listener whose connections are carried to the database by a
   * docker or vpnhop VPN's SOCKS proxy, for connections with no SSH tunnel.
   */
  private async openSocksForward(
    connection: DatabaseConnection,
    proxy: SocksProxy,
    destHost: string,
    destPort: number,
    preferredPort: number | undefined
  ): Promise<ActiveTunnel> {
    const sockets = new Set<net.Socket>();
    const timeoutMs = connection.vpn?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      socket.pause();
      socksConnect(proxy, destHost, destPort, timeoutMs).then(
        (upstream) => {
          sockets.add(upstream);
          upstream.on('close', () => sockets.delete(upstream));
          upstream.on('error', () => socket.destroy());
          socket.on('error', () => upstream.destroy());
          socket.on('close', () => upstream.destroy());
          upstream.on('close', () => socket.destroy());
          socket.pipe(upstream).pipe(socket);
        },
        (error: Error) => {
          this.log(`VPN forward to ${destHost}:${destPort} failed: ${error.message}`);
          vpnManager.forgetProxy(connection);
          socket.destroy();
        }
      );
    });
    const bind = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        // Loopback only: anything reaching this port reaches the database.
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          const address = server.address();
          if (address && typeof address === 'object') resolve(address.port);
          else reject(new Error('Failed to allocate a local port for the VPN forward'));
        });
      });
    let localPort: number;
    try {
      localPort = await bind(preferredPort ?? 0);
    } catch (error) {
      if (!preferredPort) throw error;
      localPort = await bind(0);
    }
    this.log(`VPN forward up for "${connection.name}" on 127.0.0.1:${localPort}`);
    const tunnel: ActiveTunnel = {
      alive: true,
      host: '127.0.0.1',
      port: localPort,
      close: async () => {
        tunnel.alive = false;
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
    server.on('error', () => {
      tunnel.alive = false;
    });
    return tunnel;
  }

  /** SSM port forwarding: the plugin itself is the local listener. */
  private async openPortForward(
    connection: DatabaseConnection,
    ssm: SsmConfig,
    destHost: string,
    destPort: number,
    preferredPort: number | undefined
  ): Promise<ActiveTunnel> {
    const localPort = await pickLocalPort(preferredPort);
    const session = await startSsmPortForward(
      await resolveSsmTarget(ssm),
      destHost,
      destPort,
      localPort,
      connection.sshTunnel?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    );
    this.log(`SSM port forward up for "${connection.name}" on 127.0.0.1:${localPort}`);
    const tunnel: ActiveTunnel = {
      alive: true,
      host: '127.0.0.1',
      port: localPort,
      close: async () => {
        tunnel.alive = false;
        session.kill();
        await session.exited(1000);
      },
    };
    // The session ending is the tunnel dying: the next resolve reopens it.
    session.child.once('exit', () => {
      tunnel.alive = false;
    });
    return tunnel;
  }

  private async open(
    connection: DatabaseConnection,
    config: SshTunnelConfig | undefined,
    destHost: string,
    destPort: number,
    preferredPort?: number,
    proxy?: SocksProxy
  ): Promise<ActiveTunnel> {
    if (!config?.enabled) {
      throw new Error(
        `Connection "${connection.name}" uses SSM in ssh mode, which carries an SSH tunnel; ` +
          `enable the SSH tunnel in DBeaver (and drop any ssh override with enabled: false) or use ssm mode "port-forward".`
      );
    }
    // Built up front so a missing key or user on any hop fails before dialling.
    const hops = [...(config.jumpHosts ?? []), config].map((hop) => ({
      hop,
      options: buildConnectOptions(hop, connection.name),
    }));

    // Imported lazily so a workspace with no tunneled connections never pays
    // for it, and so a broken optional native dep degrades to a clear message.
    let SshClient: new () => import('ssh2').Client;
    try {
      ({ Client: SshClient } = await import('ssh2'));
    } catch (error) {
      throw new Error(
        `Connection "${connection.name}" needs an SSH tunnel, but the ssh2 module could not be ` +
          `loaded: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const knownHosts = loadKnownHosts();
    const strict = booleanSetting(
      process.env.HOPSQL_SSH_STRICT_HOST_KEY,
      'HOPSQL_SSH_STRICT_HOST_KEY',
      true
    );

    // Each hop after the first is dialled through the previous hop's forward,
    // so every host - bastions included - gets its own host key check.
    const clients: import('ssh2').Client[] = [];
    let session: SsmSession | undefined;
    try {
      for (const { hop, options } of hops) {
        const previous = clients[clients.length - 1];
        let sock: import('stream').Duplex | undefined;
        if (previous) {
          sock = await this.forwardThrough(previous, hop.host, hop.port, connection.name);
        } else if (connection.ssm?.mode === 'ssh') {
          // ProxyCommand equivalent: the first hop rides on the SSM session.
          const ssm = await resolveSsmTarget(connection.ssm);
          session = await startSsmSession(
            ssm,
            ssmArgs(ssm, 'AWS-StartSSHSession', { portNumber: String(hop.port) })
          );
          sock = childStream(session.child);
        } else if (proxy) {
          // The first hop is reached through the docker or vpnhop VPN's proxy.
          sock = await socksConnect(
            proxy,
            hop.host,
            hop.port,
            hop.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
          );
        }
        clients.push(
          await this.connectHop(
            new SshClient(),
            hop,
            { ...options, ...(sock ? { sock } : {}) },
            connection.name,
            knownHosts,
            strict
          )
        );
      }
    } catch (error) {
      for (const opened of clients.reverse()) opened.destroy();
      if (session) {
        // An SSO or CLI failure ends the session, which ssh2 only reports as
        // a closed transport - prefer the AWS reason when there is one.
        await session.exited(1000);
        const failure = session.failure();
        session.kill();
        if (failure) throw failure;
      }
      throw error;
    }
    const client = clients[clients.length - 1];

    try {
      return await this.listen(
        connection,
        config,
        client,
        clients,
        destHost,
        destPort,
        preferredPort,
        session
      );
    } catch (error) {
      for (const opened of clients.reverse()) opened.destroy();
      session?.kill();
      throw error;
    }
  }

  /** Open a direct-tcpip channel to the next hop, for use as its transport. */
  private forwardThrough(
    client: import('ssh2').Client,
    host: string,
    port: number,
    connectionName: string
  ): Promise<import('stream').Duplex> {
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
        if (error) {
          reject(
            new Error(
              `Could not reach SSH hop ${host}:${port} for connection "${connectionName}" ` +
                `through the previous jump server: ${error.message}`
            )
          );
          return;
        }
        resolve(stream);
      });
    });
  }

  private async connectHop(
    client: import('ssh2').Client,
    config: SshTunnelConfig,
    options: Record<string, unknown>,
    connectionName: string,
    knownHosts: ReturnType<typeof loadKnownHosts>,
    strict: boolean
  ): Promise<import('ssh2').Client> {
    // Keep an error listener after authentication: late transport failures are normal.
    client.on('error', (error) => this.log(`SSH transport failed: ${error.message}`));
    let hostKeyError: Error | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          client.removeListener('ready', onReady);
          // A rejected host key closes the transport, and ssh2 reports that
          // close rather than the reason - so prefer the reason we recorded.
          reject(hostKeyError ?? this.decorateSshError(error, connectionName, config));
        };
        const onReady = () => {
          client.removeListener('error', onError);
          resolve();
        };

        client.once('ready', onReady);
        client.once('error', onError);

        client.connect({
          ...options,
          hostVerifier: (key: Buffer, callback: (ok: boolean) => void) => {
            const verdict = verifyHostKey(
              config.host,
              config.port,
              detectKeyType(key),
              key,
              knownHosts
            );

            if (verdict.status === 'match') {
              callback(true);
              return;
            }

            if (verdict.status === 'mismatch') {
              hostKeyError = new Error(
                `Host key verification failed for SSH host ${config.host}:${config.port}. The key ` +
                  `it presented (${keyFingerprint(key)}) does not match the ${verdict.expectedTypes.join(
                    ', '
                  )} entry in ${knownHostsPath()}. Refusing to tunnel database credentials ` +
                  `through it. If the host was legitimately rekeyed, remove the stale entry.`
              );
              callback(false);
              return;
            }

            if (strict) {
              hostKeyError = new UnknownHostKeyError(
                `SSH host ${config.host}:${config.port} is not in ${knownHostsPath()} and ` +
                  `strict verification is enabled. Its key is ${keyFingerprint(key)}; connect ` +
                  `once with ssh, verify the fingerprint through a trusted source, and record it, then retry.`,
                config.host,
                config.port,
                detectKeyType(key),
                key
              );
              callback(false);
              return;
            }

            this.log(
              `SSH host ${config.host}:${config.port} is not in known_hosts; accepting ` +
                `${keyFingerprint(key)}. Legacy verification was explicitly enabled with HOPSQL_SSH_STRICT_HOST_KEY=false.`
            );
            callback(true);
          },
        } as Parameters<import('ssh2').Client['connect']>[0]);
      });
    } catch (error) {
      client.destroy();
      throw error;
    }
    return client;
  }

  private async listen(
    connection: DatabaseConnection,
    config: SshTunnelConfig,
    client: import('ssh2').Client,
    clients: import('ssh2').Client[],
    destHost: string,
    destPort: number,
    preferredPort?: number,
    session?: SsmSession
  ): Promise<ActiveTunnel> {
    const sockets = new Set<net.Socket>();
    // Bind to loopback only: this forward is for this process, and anything
    // reachable on it inherits the SSH server's access to the database.
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      client.forwardOut(
        '127.0.0.1',
        socket.remotePort ?? 0,
        destHost,
        destPort,
        (error, stream) => {
          if (error) {
            this.log(`Forward to ${destHost}:${destPort} failed: ${error.message}`);
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        }
      );
    });

    const bind = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          const address = server.address();
          if (address && typeof address === 'object') {
            resolve(address.port);
          } else {
            reject(new Error('Failed to allocate a local port for the SSH tunnel'));
          }
        });
      });
    let localPort: number;
    try {
      localPort = await bind(preferredPort ?? 0);
    } catch (error) {
      if (!preferredPort) throw error;
      this.log(`Previous tunnel port ${preferredPort} is taken; using a new one`);
      localPort = await bind(0);
    }

    const route = [...(config.jumpHosts ?? []), config].map((hop) => `${hop.host}:${hop.port}`);
    this.log(
      `Tunnel up for "${connection.name}": 127.0.0.1:${localPort} -> ` +
        `${route.join(' -> ')} -> ${destHost}:${destPort}`
    );
    // Innermost first, so each hop closes before the transport it rides on.
    const endAll = () => {
      for (const hop of [...clients].reverse()) hop.end();
    };
    const destroyAll = () => {
      for (const hop of [...clients].reverse()) hop.destroy();
      session?.kill();
    };

    const tunnel: ActiveTunnel = {
      alive: true,
      host: '127.0.0.1',
      port: localPort,
      close: async () => {
        tunnel.alive = false;
        for (const socket of sockets) socket.destroy();
        endAll();
        await new Promise<void>((resolve) => {
          const deadline = setTimeout(() => {
            destroyAll();
            resolve();
          }, 500);
          server.close(() => {
            clearTimeout(deadline);
            destroyAll();
            resolve();
          });
        });
      },
    };
    const invalidate = () => {
      tunnel.alive = false;
      for (const socket of sockets) socket.destroy();
      if (server.listening) server.close();
    };
    // Losing any hop takes down every hop inside it.
    for (const hop of clients) {
      hop.once('close', invalidate);
      hop.once('end', invalidate);
    }
    session?.child.once('exit', invalidate);
    server.on('error', (error) => {
      this.log(`SSH forward failed: ${error.message}`);
      invalidate();
      destroyAll();
    });
    return tunnel;
  }

  /**
   * The SSH layer's own errors say nothing about which connection was being
   * opened, which is what the user needs to act.
   */
  private decorateSshError(error: Error, connectionName: string, config: SshTunnelConfig): Error {
    const target = `${config.host}:${config.port}`;
    const message = error.message || String(error);

    if (/All configured authentication methods failed/i.test(message)) {
      return new Error(
        `SSH authentication to ${target} failed for the tunnel behind connection ` +
          `"${connectionName}" (as ${config.user}, ${resolveAuthType(config).toLowerCase()} auth). ` +
          `${message}`
      );
    }

    return new Error(
      `Could not open the SSH tunnel to ${target} for connection "${connectionName}": ${message}`
    );
  }

  async close(connectionId: string): Promise<void> {
    const tunnel = this.tunnels.get(connectionId);
    if (!tunnel) {
      return;
    }
    this.tunnels.delete(connectionId);
    try {
      await tunnel.close();
    } catch (error) {
      this.log(`Error closing tunnel for ${connectionId}: ${error}`);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(this.pending.values());
    await Promise.all(Array.from(this.tunnels.keys()).map((id) => this.close(id)));
  }

  hasTunnel(connectionId: string): boolean {
    return this.tunnels.has(connectionId);
  }
}

/**
 * Read the algorithm name out of an SSH host key blob.
 *
 * The wire format is a length-prefixed string, and it is the same name
 * known_hosts records in its key-type column.
 */
export function detectKeyType(key: Buffer): string {
  if (key.length < 4) {
    return '';
  }
  const length = key.readUInt32BE(0);
  if (length <= 0 || key.length < 4 + length) {
    return '';
  }
  return key.subarray(4, 4 + length).toString('utf8');
}

export const sshTunnelManager = new SshTunnelManager();
