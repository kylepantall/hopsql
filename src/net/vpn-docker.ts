/**
 * An OpenVPN client in a Docker container, so only hopsql's traffic uses the
 * VPN: the container has its own network namespace and routes, and exposes a
 * SOCKS5 proxy (dante) on a loopback-published port that hopsql dials through.
 *
 * The image is built locally from the Dockerfile below on first use, from a
 * digest-pinned Alpine base, so no third-party VPN image is trusted. Its tag
 * is a hash of the Dockerfile, so a changed recipe builds a new image.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeDiagnostic } from '../privacy.js';
import type { SocksProxy } from './socks.js';
import type { CommandRunner } from './vpn.js';

/**
 * - openvpn 2.6 rejects a pushed cipher spelled in lowercase (`aes-128-gcm`)
 *   that its own canonical list has in uppercase. A server pushing that is
 *   one whose profile spells it so too: ignore the push and use the
 *   profile's cipher, uppercased, which is the same cipher.
 * - Docker's DNS server is pinned to eth0, so a `redirect-gateway` VPN cannot
 *   capture it and reconnects can still resolve the VPN server.
 * Options after --config override the profile's.
 */
const ENTRYPOINT = `#!/bin/sh
set -e
[ -c /dev/net/tun ] || { mkdir -p /dev/net; mknod /dev/net/tun c 10 200; }
cp /etc/resolv.conf /etc/resolv.conf.docker
gw=$(ip route | awk '/^default/ {print $3; exit}')
for ns in $(awk '/^nameserver/ {print $2}' /etc/resolv.conf.docker); do
  case "$ns" in 127.*|*:*) ;; *) ip route replace "$ns/32" via "$gw" dev eth0 ;; esac
done
cipher=$(awk '$1 == "cipher" {print $2; exit}' /vpn/config.ovpn)
case "$cipher" in
  *[a-z]*)
    upper=$(echo "$cipher" | tr a-z A-Z)
    set -- --pull-filter ignore cipher --data-ciphers-fallback "$upper" \\
      --data-ciphers "$upper:AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305" ;;
esac
exec openvpn --config /vpn/config.ovpn --dev tun0 --auth-nocache \\
  --script-security 2 --route-up /usr/local/bin/hopsql-route-up --down /usr/local/bin/hopsql-down "$@"
`;

/**
 * After routes are up: put the VPN's DNS first, keeping Docker's as a
 * fallback, then (re)start the proxy so it binds the new tun0.
 */
const ROUTE_UP = `#!/bin/sh
dns=; search=; i=1
while :; do
  eval "opt=\\\${foreign_option_$i}"
  [ -n "$opt" ] || break
  case "$opt" in
    "dhcp-option DNS "*) dns="$dns \${opt#dhcp-option DNS }" ;;
    "dhcp-option DOMAIN "*|"dhcp-option DOMAIN-SEARCH "*) search="$search \${opt##* }" ;;
  esac
  i=$((i+1))
done
if [ -n "$dns" ]; then
  {
    [ -n "$search" ] && echo "search$search"
    for d in $dns; do echo "nameserver $d"; done
    grep '^nameserver' /etc/resolv.conf.docker
  } > /etc/resolv.conf
fi
pkill -x sockd 2>/dev/null || true
sockd -f /etc/sockd.conf &
exit 0
`;

/** Tunnel going down (including before a reconnect): Docker's DNS can still resolve the server. */
const DOWN = `#!/bin/sh
pkill -x sockd 2>/dev/null || true
cat /etc/resolv.conf.docker > /etc/resolv.conf
exit 0
`;

const SOCKD_CONF = `logoutput: stderr
internal: 0.0.0.0 port = 1080
external: eth0
external: tun0
external.rotation: route
clientmethod: none
socksmethod: none
user.privileged: root
user.unprivileged: nobody
client pass {
  from: 0.0.0.0/0 to: 0.0.0.0/0
}
socks pass {
  from: 0.0.0.0/0 to: 0.0.0.0/0
  command: connect
}
`;

const b64 = (text: string) => Buffer.from(text).toString('base64');

export const DOCKERFILE = `FROM alpine:3.22@sha256:bfe7ceb9f09ec0566c48fb93356e45a47a00be5a1dd14fa5b909e7709c66b034
RUN apk add --no-cache openvpn dante-server \\
 && echo ${b64(ENTRYPOINT)} | base64 -d > /usr/local/bin/hopsql-vpn \\
 && echo ${b64(ROUTE_UP)} | base64 -d > /usr/local/bin/hopsql-route-up \\
 && echo ${b64(DOWN)} | base64 -d > /usr/local/bin/hopsql-down \\
 && echo ${b64(SOCKD_CONF)} | base64 -d > /etc/sockd.conf \\
 && chmod 755 /usr/local/bin/hopsql-vpn /usr/local/bin/hopsql-route-up /usr/local/bin/hopsql-down
LABEL hopsql.vpn=1
ENTRYPOINT ["/usr/local/bin/hopsql-vpn"]
`;

export const IMAGE = `hopsql-vpn:${createHash('sha256').update(DOCKERFILE).digest('hex').slice(0, 12)}`;
const PROXY_PORT = '1080/tcp';
const COMMAND_TIMEOUT_MS = 30000;
const BUILD_TIMEOUT_MS = 300000;

/** The docker CLI: `HOPSQL_DOCKER_PATH`, else a usual install place, else PATH. */
export function dockerPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync
): string {
  if (env.HOPSQL_DOCKER_PATH) return env.HOPSQL_DOCKER_PATH;
  // MCP clients rarely pass the shell's PATH, so look where installers put it.
  const candidates = [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    path.join(os.homedir(), '.docker', 'bin', 'docker'),
    '/Applications/Docker.app/Contents/Resources/bin/docker',
  ];
  return (process.platform === 'win32' ? undefined : candidates.find(exists)) ?? 'docker';
}

/** One container per profile file, so servers sharing a profile share the VPN. */
export function containerName(configFile: string): string {
  return `hopsql-vpn-${createHash('sha256').update(path.resolve(configFile)).digest('hex').slice(0, 12)}`;
}

/** `docker port` prints e.g. `127.0.0.1:55123`; take the IPv4 loopback one. */
export function parsePublishedPort(stdout: string): SocksProxy | undefined {
  for (const line of stdout.split('\n')) {
    const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(line.trim());
    if (match) return { host: '127.0.0.1', port: Number(match[1]) };
  }
  return undefined;
}

export class DockerVpn {
  constructor(private readonly runner: CommandRunner) {}

  private async docker(args: string[], timeoutMs = COMMAND_TIMEOUT_MS) {
    try {
      return await this.runner(dockerPath(), args, timeoutMs);
    } catch (error) {
      throw new Error(
        `Docker is not installed or not on PATH (set HOPSQL_DOCKER_PATH): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async assertAvailable(): Promise<void> {
    const result = await this.docker(['version', '--format', '{{.Server.Version}}']);
    if (result.code !== 0)
      throw new Error('Docker is not running; start Docker Desktop (or the daemon) and retry');
  }

  async ensureImage(): Promise<void> {
    if ((await this.docker(['image', 'inspect', IMAGE])).code === 0) return;
    const built = await this.buildImage();
    if (built.code !== 0)
      throw new Error(
        `Could not build the VPN image: ${sanitizeDiagnostic(built.stderr.trim().split('\n').slice(-5).join(' '))}`
      );
  }

  /** `docker build -` reads the Dockerfile from stdin; there is no build context. */
  private buildImage() {
    return this.runner(
      dockerPath(),
      ['build', '-q', '-t', IMAGE, '-'],
      BUILD_TIMEOUT_MS,
      DOCKERFILE
    );
  }

  /** True when the container exists and is running. */
  async running(name: string): Promise<boolean> {
    const result = await this.docker(['inspect', '-f', '{{.State.Running}}', name]);
    return result.code === 0 && result.stdout.trim() === 'true';
  }

  async proxy(name: string): Promise<SocksProxy | undefined> {
    const result = await this.docker(['port', name, PROXY_PORT]);
    return result.code === 0 ? parsePublishedPort(result.stdout) : undefined;
  }

  /** Start a fresh container for the profile, replacing a stopped one. */
  async start(name: string, configFile: string): Promise<void> {
    const source = path.resolve(configFile);
    // A comma would end the --mount source and start another option.
    if (source.includes(',')) throw new Error('The VPN profile path may not contain a comma');
    await this.docker(['rm', '-f', name]);
    const result = await this.docker([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'hopsql.vpn=1',
      '--cap-add',
      'NET_ADMIN',
      '--device',
      '/dev/net/tun',
      // Loopback only: anything that reaches this port reaches the VPN.
      '-p',
      `127.0.0.1::${PROXY_PORT.split('/')[0]}`,
      '--mount',
      `type=bind,source=${source},target=/vpn/config.ovpn,readonly`,
      IMAGE,
    ]);
    if (result.code !== 0)
      throw new Error(
        `Could not start the VPN container: ${sanitizeDiagnostic(result.stderr.trim())}`
      );
  }

  /** The container's last log lines, for an error message when it exits. */
  async failure(name: string): Promise<string> {
    const result = await this.docker(['logs', '--tail', '8', name]);
    const lines = `${result.stdout}\n${result.stderr}`
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return sanitizeDiagnostic(lines.slice(-4).join(' | '));
  }

  async remove(name: string): Promise<void> {
    await this.docker(['rm', '-f', name]);
  }
}
