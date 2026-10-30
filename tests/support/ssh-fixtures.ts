/** In-process SSH and echo servers for tunnel tests. Nothing here leaves loopback. */
import crypto from 'crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server as SshServer, utils as sshUtils, type Connection } from 'ssh2';

export interface Fixtures {
  cleanups: Array<() => void>;
  run(): void;
}

export function fixtures(): Fixtures {
  const cleanups: Array<() => void> = [];
  return {
    cleanups,
    run() {
      while (cleanups.length) cleanups.pop()!();
    },
  };
}

/** A TCP server that echoes back what it is sent, standing in for a database. */
export async function startEchoServer(f: Fixtures): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  f.cleanups.push(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

/**
 * An SSH server that accepts any credentials and honours direct-tcpip, with
 * its host key recorded in a temp known_hosts that HOPSQL_SSH_KNOWN_HOSTS
 * points at. `clients` lets a test drop every live session.
 */
export async function startSshServer(
  f: Fixtures
): Promise<{ port: number; clients: Set<Connection> }> {
  const key = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
  const clients = new Set<Connection>();
  const server = new SshServer({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => client.on('request', (accept) => accept?.()));
    client.on('tcpip', (accept, _reject, info) => {
      const channel = accept();
      const upstream = net.connect(info.destPort, info.destIP, () =>
        channel.pipe(upstream).pipe(channel)
      );
      upstream.on('error', () => channel.end());
    });
  });
  f.cleanups.push(() => {
    for (const client of clients) client.end();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const parsed = sshUtils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-ssh-test-'));
  const file = path.join(dir, 'known_hosts');
  fs.writeFileSync(
    file,
    `[127.0.0.1]:${port} ${parsed.type} ${parsed.getPublicSSH().toString('base64')}\n`
  );
  const saved = process.env.HOPSQL_SSH_KNOWN_HOSTS;
  process.env.HOPSQL_SSH_KNOWN_HOSTS = file;
  f.cleanups.push(() => {
    if (saved === undefined) delete process.env.HOPSQL_SSH_KNOWN_HOSTS;
    else process.env.HOPSQL_SSH_KNOWN_HOSTS = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { port, clients };
}

export function roundTrip(port: number, payload = 'ping'): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    socket.on('data', (data) => {
      resolve(data.toString());
      socket.end();
    });
    socket.on('error', reject);
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
