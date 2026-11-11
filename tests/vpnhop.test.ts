import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadManagedOverrides, parseVpn, saveManagedOverrides } from '../src/connections-config.js';
import { SshTunnelManager } from '../src/net/ssh-tunnel.js';
import { runCommand, usesVpnProxy, VpnManager, type CommandRunner } from '../src/net/vpn.js';
import {
  parseVpnhopList,
  parseVpnhopProxy,
  VPNHOP_CONNECT_TIMEOUT_MS,
  vpnhopPath,
} from '../src/net/vpnhop.js';
import { runVpnCommand } from '../src/vpn-cli.js';
import type { DatabaseConnection } from '../src/types.js';
import { restoreEnv, setEnv } from './support/environment.js';

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  restoreEnv();
  while (closers.length) closers.pop()!();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-vpnhop-'));
  dirs.push(dir);
  return dir;
}

const LATER = '2099-01-01T00:00:00.000Z';

/**
 * A fake `vpnhop` executable. It logs each argv to `calls`, prints
 * `proxy.json` / `list.json`, and fails with `proxy.err` on stderr when present.
 */
function fakeVpnhop(options: { proxy?: object; list?: object[] } = {}) {
  const dir = tempDir();
  const file = (name: string) => path.join(dir, name);
  const bin = file('vpnhop');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> '${file('calls')}'
case "$1" in
  proxy)
    if [ -f '${file('proxy.err')}' ]; then cat '${file('proxy.err')}' >&2; exit 1; fi
    cat '${file('proxy.json')}' ;;
  list) cat '${file('list.json')}' ;;
  *) echo "unknown command" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  const setProxy = (proxy: object) => fs.writeFileSync(file('proxy.json'), JSON.stringify(proxy));
  setProxy(options.proxy ?? { profile: 'aws', host: '127.0.0.1', port: 1080, expiresAt: LATER });
  fs.writeFileSync(
    file('list.json'),
    JSON.stringify(
      options.list ?? [{ name: 'aws', type: 'openvpn', description: 'AWS VPC', state: 'up' }]
    )
  );
  setEnv('VPNHOP_BIN', bin);
  return {
    bin,
    setProxy,
    fail: (stderr: string) => fs.writeFileSync(file('proxy.err'), stderr),
    calls: (): string[] =>
      fs.existsSync(file('calls'))
        ? fs.readFileSync(file('calls'), 'utf8').trim().split('\n').filter(Boolean)
        : [],
  };
}

function vpnhopConnection(extra: Partial<DatabaseConnection> = {}, profile = 'aws') {
  return {
    id: 'db',
    name: 'db',
    driver: 'postgres',
    url: '',
    host: 'db.internal',
    port: 5432,
    vpn: { provider: 'vpnhop', profile },
    ...extra,
  } as DatabaseConnection;
}

function managerAt(clock: { now: number }, runner: CommandRunner = runCommand) {
  return new VpnManager({ runner, now: () => clock.now, sleep: async () => {} });
}

describe('vpnhop VPN config', () => {
  it('accepts a vpnhop profile and connectTimeoutMs', () => {
    expect(parseVpn({ provider: 'vpnhop', profile: 'aws' }, 'c')).toEqual({
      provider: 'vpnhop',
      profile: 'aws',
    });
    expect(
      parseVpn({ provider: 'vpnhop', profile: 'work_vpn-2', connectTimeoutMs: 90000 }, 'c')
    ).toEqual({ provider: 'vpnhop', profile: 'work_vpn-2', connectTimeoutMs: 90000 });
  });

  it('rejects malformed vpnhop settings', () => {
    for (const bad of [
      { provider: 'vpnhop' },
      { provider: 'vpnhop', profile: '' },
      { provider: 'vpnhop', profile: '--json' },
      { provider: 'vpnhop', profile: 'Has Spaces' },
      { provider: 'vpnhop', profile: 'a'.repeat(50) },
      { provider: 'vpnhop', profile: 7 },
      { provider: 'vpnhop', profile: 'aws', config: '/a.ovpn' },
      // hopsql never stops vpnhop tunnels.
      { provider: 'vpnhop', profile: 'aws', disconnectOnExit: true },
      { provider: 'vpnhop', profile: 'aws', connectTimeoutMs: 10 },
    ])
      expect(() => parseVpn(bad, 'c')).toThrow();
  });

  it('is dialled through a proxy', () => {
    expect(usesVpnProxy(vpnhopConnection())).toBe(true);
  });
});

describe('vpnhop command line', () => {
  it('is found via VPNHOP_BIN, then ~/.local/bin, then PATH', () => {
    expect(vpnhopPath({ VPNHOP_BIN: '/opt/vpnhop' }, '/home/u', () => true)).toBe('/opt/vpnhop');
    expect(vpnhopPath({}, '/home/u', () => true)).toBe(
      path.join('/home/u', '.local', 'bin', 'vpnhop')
    );
    expect(vpnhopPath({}, '/home/u', () => false)).toBe('vpnhop');
  });

  it('parses the proxy contract and refuses anything off it', () => {
    expect(
      parseVpnhopProxy(
        JSON.stringify({ profile: 'aws', host: '127.0.0.1', port: 49321, expiresAt: LATER })
      )
    ).toEqual({ host: '127.0.0.1', port: 49321, expiresAt: Date.parse(LATER) });
    for (const bad of [
      'not json',
      '[]',
      JSON.stringify({ host: '10.0.0.5', port: 1080, expiresAt: LATER }),
      JSON.stringify({ host: '127.0.0.1', port: 0, expiresAt: LATER }),
      JSON.stringify({ host: '127.0.0.1', port: '1080', expiresAt: LATER }),
      JSON.stringify({ host: '127.0.0.1', port: 1080, expiresAt: 'soon' }),
      JSON.stringify({ host: '127.0.0.1', port: 1080 }),
    ])
      expect(() => parseVpnhopProxy(bad)).toThrow();
  });

  it('parses the profile list', () => {
    expect(
      parseVpnhopList(JSON.stringify([{ name: 'aws', type: 'openvpn', state: 'down' }, { x: 1 }]))
    ).toEqual([{ name: 'aws', type: 'openvpn', state: 'down' }]);
    expect(() => parseVpnhopList('{}')).toThrow();
  });
});

describe('VpnManager with a vpnhop VPN', () => {
  it('runs `vpnhop proxy <profile> --json` and returns its proxy', async () => {
    const fake = fakeVpnhop();
    const proxy = await managerAt({ now: 0 }).proxyFor(vpnhopConnection());
    expect(proxy).toEqual({ host: '127.0.0.1', port: 1080 });
    expect(fake.calls()).toEqual(['proxy aws --json']);
  });

  it('runs argv only, with connectTimeoutMs (default 90s) as the timeout', async () => {
    const runs: { command: string; args: string[]; timeoutMs: number }[] = [];
    const runner: CommandRunner = async (command, args, timeoutMs) => {
      runs.push({ command, args, timeoutMs });
      return {
        code: 0,
        stdout: JSON.stringify({ host: '127.0.0.1', port: 1080, expiresAt: LATER }),
        stderr: '',
      };
    };
    setEnv('VPNHOP_BIN', '/opt/vpnhop');
    await managerAt({ now: 0 }, runner).proxyFor(vpnhopConnection());
    await managerAt({ now: 0 }, runner).proxyFor(
      vpnhopConnection({ vpn: { provider: 'vpnhop', profile: 'aws', connectTimeoutMs: 5000 } })
    );
    expect(runs).toEqual([
      {
        command: '/opt/vpnhop',
        args: ['proxy', 'aws', '--json'],
        timeoutMs: VPNHOP_CONNECT_TIMEOUT_MS,
      },
      { command: '/opt/vpnhop', args: ['proxy', 'aws', '--json'], timeoutMs: 5000 },
    ]);
  });

  it('caches the proxy briefly and shares one call between concurrent dials', async () => {
    const fake = fakeVpnhop();
    const clock = { now: 0 };
    const vpn = managerAt(clock);
    await Promise.all([vpn.proxyFor(vpnhopConnection()), vpn.proxyFor(vpnhopConnection())]);
    clock.now = 10_000;
    await vpn.proxyFor(vpnhopConnection());
    expect(fake.calls()).toHaveLength(1);
    // Past the short cache it asks again, which extends vpnhop's lease.
    clock.now = 31_000;
    await vpn.proxyFor(vpnhopConnection());
    expect(fake.calls()).toHaveLength(2);
  });

  it('never caches past expiresAt, and picks up a new proxy on refresh', async () => {
    const start = Date.parse('2026-11-11T12:00:00.000Z');
    const fake = fakeVpnhop({
      proxy: { host: '127.0.0.1', port: 1080, expiresAt: new Date(start + 5000).toISOString() },
    });
    const clock = { now: start };
    const vpn = managerAt(clock);
    expect((await vpn.proxyFor(vpnhopConnection())).port).toBe(1080);
    clock.now = start + 4000;
    await vpn.proxyFor(vpnhopConnection());
    expect(fake.calls()).toHaveLength(1);
    fake.setProxy({ host: '127.0.0.1', port: 2080, expiresAt: LATER });
    clock.now = start + 5000;
    expect((await vpn.proxyFor(vpnhopConnection())).port).toBe(2080);
    expect(fake.calls()).toHaveLength(2);
  });

  it('asks again after a dial failure', async () => {
    const fake = fakeVpnhop();
    const vpn = managerAt({ now: 0 });
    await vpn.proxyFor(vpnhopConnection());
    vpn.forgetProxy(vpnhopConnection());
    await vpn.proxyFor(vpnhopConnection());
    expect(fake.calls()).toHaveLength(2);
  });

  it('surfaces vpnhop stderr on failure, sanitised', async () => {
    const fake = fakeVpnhop();
    fake.fail('profile secret-net: AUTH_FAILED at /Users/someone/.config/x for 10.1.2.3\n');
    const error = await managerAt({ now: 0 })
      .proxyFor(vpnhopConnection({}, 'secret-net'))
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('AUTH_FAILED');
    expect(message).not.toContain('secret-net');
    expect(message).not.toContain('/Users/someone');
    expect(message).not.toContain('10.1.2.3');
  });

  it('fails clearly when vpnhop is not installed', async () => {
    setEnv('VPNHOP_BIN', path.join(tempDir(), 'missing-vpnhop'));
    await expect(managerAt({ now: 0 }).proxyFor(vpnhopConnection())).rejects.toThrow();
  });

  it('refuses SSM connections without running vpnhop', async () => {
    const fake = fakeVpnhop();
    const vpn = managerAt({ now: 0 });
    const ssm = vpnhopConnection({ ssm: { target: 'i-1', mode: 'port-forward' } });
    await expect(vpn.proxyFor(ssm)).rejects.toThrow();
    await expect(vpn.ensure(ssm, 5432)).rejects.toThrow();
    expect(fake.calls()).toEqual([]);
  });

  it('never stops a vpnhop tunnel on exit', async () => {
    const fake = fakeVpnhop();
    const vpn = managerAt({ now: 0 });
    await vpn.proxyFor(vpnhopConnection());
    await vpn.disconnectAll();
    expect(fake.calls()).toEqual(['proxy aws --json']);
  });
});

describe('hopsql vpn with vpnhop', () => {
  const connections = async (): Promise<DatabaseConnection[]> => [
    { id: 'db', name: 'db', driver: 'postgres', url: '' },
    { id: 'other', name: 'other', driver: 'postgres', url: '' },
  ];
  // OpenVPN Connect is not consulted on these paths, or fails harmlessly in `list`.
  const offline: CommandRunner = async (command, args, timeoutMs) =>
    command === process.env.VPNHOP_BIN
      ? runCommand(command, args, timeoutMs)
      : { code: 1, stdout: '', stderr: '' };

  it('`vpn use --vpnhop` stores the provider after checking the profile exists', async () => {
    const fake = fakeVpnhop();
    const file = path.join(tempDir(), 'overrides.json');
    saveManagedOverrides({ db: { access: 'ask' } }, file);
    setEnv('HOPSQL_OVERRIDES_FILE', file);
    await runVpnCommand(['use', 'aws', 'db', '--vpnhop'], connections, () => {}, offline);
    const overrides = loadManagedOverrides(file);
    expect(overrides.db).toEqual({ access: 'ask', vpn: { provider: 'vpnhop', profile: 'aws' } });
    expect(overrides.other).toBeUndefined();
    expect(fake.calls()).toEqual(['list --json']);
    // An unknown profile, or both flags, changes nothing.
    for (const args of [
      ['use', 'nope', 'other', '--vpnhop'],
      ['use', 'aws', 'other', '--vpnhop', '--docker'],
    ])
      await expect(runVpnCommand(args, connections, () => {}, offline)).rejects.toThrow();
    expect(loadManagedOverrides(file).other).toBeUndefined();
  });

  it('`vpn list` shows vpnhop profiles and connections using them', async () => {
    fakeVpnhop({
      list: [
        { name: 'aws', type: 'openvpn', description: 'AWS VPC', state: 'up' },
        { name: 'office', type: 'wireguard', description: '', state: 'down' },
      ],
    });
    const lines: string[] = [];
    await runVpnCommand(
      ['list'],
      async () => [vpnhopConnection()],
      (line) => lines.push(line),
      offline
    );
    const output = lines.join('\n');
    expect(output).toContain('aws');
    expect(output).toContain('office');
    expect(lines.some((l) => l.includes('db') && l.includes('vpnhop'))).toBe(true);
  });

  it('`vpn list` still lists connections when vpnhop is missing', async () => {
    setEnv('VPNHOP_BIN', path.join(tempDir(), 'missing-vpnhop'));
    const lines: string[] = [];
    await runVpnCommand(
      ['list'],
      async () => [vpnhopConnection()],
      (l) => lines.push(l),
      offline
    );
    expect(lines.some((l) => l.includes('db') && l.includes('vpnhop'))).toBe(true);
  });
});

describe('dialling through the proxy vpnhop returns', () => {
  function listen(server: net.Server): Promise<number> {
    closers.push(() => server.close());
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    );
  }

  /** A real SOCKS5 server (no auth, CONNECT) that records targets and splices to `upstream`. */
  async function socksServer(upstream: number) {
    const targets: string[] = [];
    const port = await listen(
      net.createServer((client) => {
        client.on('error', () => {});
        client.once('data', () => {
          client.write(Buffer.from([5, 0]));
          client.once('data', (request: Buffer) => {
            const host =
              request[3] === 1
                ? [...request.subarray(4, 8)].join('.')
                : request.subarray(5, 5 + request[4]).toString();
            targets.push(`${host}:${request.readUInt16BE(request.length - 2)}`);
            const out = net.connect(upstream, '127.0.0.1', () => {
              client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
              client.pipe(out).pipe(client);
            });
            out.on('error', () => client.destroy());
          });
        });
      })
    );
    return { port, targets };
  }

  it('carries a direct connection to the database by hostname', async () => {
    const echo = await listen(net.createServer((socket) => socket.pipe(socket)));
    const socks = await socksServer(echo);
    fakeVpnhop({
      proxy: { profile: 'itest', host: '127.0.0.1', port: socks.port, expiresAt: LATER },
    });
    const manager = new SshTunnelManager();
    const connection = vpnhopConnection({ id: 'vpnhop-itest' }, 'itest');
    try {
      const endpoint = await manager.resolveEndpoint(connection, 5432);
      expect(endpoint?.host).toBe('127.0.0.1');
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(endpoint!.port, endpoint!.host, () => socket.write('ping'));
        socket.once('data', (data) => {
          socket.destroy();
          resolve(data.toString());
        });
        socket.once('error', reject);
      });
      expect(reply).toBe('ping');
      expect(socks.targets).toEqual(['db.internal:5432']);
    } finally {
      await manager.closeAll();
    }
  });

  it('asks vpnhop again after a dial through its proxy fails', async () => {
    // A port nothing listens on: the tunnel was restarted elsewhere.
    const dead = await listen(net.createServer());
    closers.pop()!();
    const fake = fakeVpnhop({ proxy: { host: '127.0.0.1', port: dead, expiresAt: LATER } });
    const manager = new SshTunnelManager();
    const connection = vpnhopConnection({ id: 'vpnhop-itest-dead' }, 'itest-dead');
    try {
      const endpoint = await manager.resolveEndpoint(connection, 5432);
      await new Promise<void>((resolve) => {
        const socket = net.connect(endpoint!.port, endpoint!.host);
        socket.on('error', () => {});
        socket.once('close', () => resolve());
      });
      await manager.resolveEndpoint(connection, 5432);
      expect(fake.calls()).toHaveLength(2);
    } finally {
      await manager.closeAll();
    }
  });
});
