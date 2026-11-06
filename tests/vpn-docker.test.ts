import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseVpn } from '../src/connections-config.js';
import { socksAvailable, socksConnect, socksReplyLength, socksRequest } from '../src/net/socks.js';
import { containerName, parsePublishedPort, type DockerVpn } from '../src/net/vpn-docker.js';
import { VpnManager } from '../src/net/vpn.js';
import type { DatabaseConnection } from '../src/types.js';

const closers: (() => void)[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function listen(server: net.Server): Promise<number> {
  closers.push(() => server.close());
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
  );
}

/** A SOCKS5 server that records CONNECT targets and splices to `upstreamPort`. */
async function fakeSocks(upstreamPort: number, reply = 0) {
  const targets: string[] = [];
  const port = await listen(
    net.createServer((client) => {
      client.once('data', () => {
        client.write(Buffer.from([5, 0]));
        client.once('data', (request: Buffer) => {
          const atyp = request[3];
          const host =
            atyp === 1
              ? [...request.subarray(4, 8)].join('.')
              : request.subarray(5, 5 + request[4]).toString();
          targets.push(`${host}:${request.readUInt16BE(request.length - 2)}`);
          if (reply !== 0) return void client.end(Buffer.from([5, reply, 0, 1, 0, 0, 0, 0, 0, 0]));
          const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            client.pipe(upstream).pipe(client);
          });
          upstream.on('error', () => client.destroy());
        });
      });
      client.on('error', () => {});
    })
  );
  return { port, targets };
}

async function echoServer(): Promise<number> {
  return listen(net.createServer((socket) => socket.pipe(socket)));
}

describe('docker VPN config', () => {
  it('accepts a profile or an absolute .ovpn path, not both', () => {
    expect(parseVpn({ provider: 'docker', profile: '42' }, 'c')).toEqual({
      provider: 'docker',
      profile: '42',
    });
    expect(parseVpn({ provider: 'docker', config: '~/vpn/work.ovpn' }, 'c')).toEqual({
      provider: 'docker',
      config: '~/vpn/work.ovpn',
    });
    for (const bad of [
      { provider: 'docker' },
      { provider: 'docker', profile: '42', config: '/a.ovpn' },
      { provider: 'docker', config: 'relative.ovpn' },
      { provider: 'docker', config: '/a,b.ovpn' },
      { provider: 'docker', profile: '--rm' },
      { provider: 'docker', up: ['x'] },
    ])
      expect(() => parseVpn(bad, 'c')).toThrow();
  });
});

describe('SOCKS5 client', () => {
  it('encodes IPv4 and hostname requests', () => {
    expect([...socksRequest('10.0.0.5', 5432)]).toEqual([5, 1, 0, 1, 10, 0, 0, 5, 0x15, 0x38]);
    expect([...socksRequest('db', 22)]).toEqual([5, 1, 0, 3, 2, 100, 98, 0, 22]);
    expect(socksReplyLength(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0]))).toBe(0);
    expect(socksReplyLength(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0, 9]))).toBe(10);
  });

  it('connects through the proxy by hostname and carries data both ways', async () => {
    const socks = await fakeSocks(await echoServer());
    const socket = await socksConnect(
      { host: '127.0.0.1', port: socks.port },
      'db.internal',
      5432,
      2000
    );
    closers.push(() => socket.destroy());
    const echoed = new Promise<string>((resolve) =>
      socket.once('data', (data) => resolve(data.toString()))
    );
    socket.resume();
    socket.write('ping');
    expect(await echoed).toBe('ping');
    expect(socks.targets).toEqual(['db.internal:5432']);
  });

  it('rejects when the proxy cannot reach the destination', async () => {
    const socks = await fakeSocks(await echoServer(), 4);
    await expect(
      socksConnect({ host: '127.0.0.1', port: socks.port }, 'db', 1, 2000)
    ).rejects.toThrow();
  });

  it('reports whether a proxy is serving', async () => {
    const socks = await fakeSocks(await echoServer());
    expect(await socksAvailable({ host: '127.0.0.1', port: socks.port }, 1000)).toBe(true);
    const closed = await listen(net.createServer((s) => s.destroy()));
    expect(await socksAvailable({ host: '127.0.0.1', port: closed }, 1000)).toBe(false);
  });
});

describe('docker helpers', () => {
  it('parses the loopback published port', () => {
    expect(parsePublishedPort('0.0.0.0:1\n127.0.0.1:55123\n')).toEqual({
      host: '127.0.0.1',
      port: 55123,
    });
    expect(parsePublishedPort('')).toBeUndefined();
  });

  it('names one container per profile file', () => {
    expect(containerName('/a/work.ovpn')).toBe(containerName('/a/work.ovpn'));
    expect(containerName('/a/work.ovpn')).not.toBe(containerName('/a/home.ovpn'));
    expect(containerName('/a/work.ovpn')).toMatch(/^hopsql-vpn-[0-9a-f]{12}$/);
  });
});

/** A DockerVpn stand-in whose container is running once started (or from the outset). */
function fakeDocker(options: { running?: boolean; stopsAfterStart?: boolean } = {}) {
  let running = options.running ?? false;
  const calls: string[] = [];
  const docker = {
    assertAvailable: async () => void calls.push('available'),
    ensureImage: async () => void calls.push('image'),
    running: async () => running,
    proxy: async () => ({ host: '127.0.0.1', port: 1080 }),
    start: async () => {
      calls.push('start');
      running = !options.stopsAfterStart;
    },
    failure: async () => 'AUTH_FAILED',
    remove: async () => void calls.push('remove'),
  } as unknown as DockerVpn;
  return { docker, calls };
}

function dockerConnection(file: string, extra: object = {}): DatabaseConnection {
  return {
    id: 'db',
    name: 'db',
    driver: 'postgres',
    url: '',
    host: 'db.internal',
    vpn: { provider: 'docker', config: file, ...extra },
  };
}

function profileFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-vpn-docker-'));
  dirs.push(dir);
  const file = path.join(dir, 'work.ovpn');
  fs.writeFileSync(file, 'client\n');
  return file;
}

describe('VpnManager with a docker VPN', () => {
  const manager = (docker: DockerVpn, ready = async () => true) => {
    let clock = 0;
    return new VpnManager({
      docker,
      socksReady: ready,
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
    });
  };

  it('starts a container, returns its proxy, and removes it on exit', async () => {
    const { docker, calls } = fakeDocker();
    const vpn = manager(docker);
    expect(await vpn.proxyFor(dockerConnection(profileFile()))).toEqual({
      host: '127.0.0.1',
      port: 1080,
    });
    expect(calls).toEqual(['available', 'image', 'start']);
    await vpn.disconnectAll();
    expect(calls.at(-1)).toBe('remove');
  });

  it("reuses another server's running container and leaves it running", async () => {
    const { docker, calls } = fakeDocker({ running: true });
    const vpn = manager(docker);
    await vpn.proxyFor(dockerConnection(profileFile()));
    await vpn.disconnectAll();
    expect(calls).toEqual(['available']);
  });

  it('reports the container log when it stops', async () => {
    const { docker } = fakeDocker({ stopsAfterStart: true });
    await expect(manager(docker).proxyFor(dockerConnection(profileFile()))).rejects.toThrow();
  });

  it('times out when the proxy never serves, and removes the container it started', async () => {
    const { docker, calls } = fakeDocker();
    await expect(
      manager(docker, async () => false).proxyFor(
        dockerConnection(profileFile(), { connectTimeoutMs: 3000 })
      )
    ).rejects.toThrow();
    expect(calls.at(-1)).toBe('remove');
  });

  it('refuses SSM connections and missing profile files', async () => {
    const { docker } = fakeDocker();
    await expect(
      manager(docker).proxyFor({
        ...dockerConnection(profileFile()),
        ssm: { target: 'i-1', mode: 'port-forward' },
      })
    ).rejects.toThrow();
    await expect(manager(docker).proxyFor(dockerConnection('/no/such.ovpn'))).rejects.toThrow();
  });
});
