import { describe, it, expect, afterEach } from 'bun:test';
import net from 'node:net';
import type { Pool as PgPool } from 'pg';
import { ConnectionPoolManager } from '../src/pools/connection-pool.js';
import { postgresSslNegotiable } from '../src/auth/ssl.js';
import type { DatabaseConnection } from '../src/types.js';

/** pg's SSLRequest code, sent in place of a startup message to ask for TLS. */
const SSL_REQUEST = 80877103;
/** Protocol 3.0, the version field of a plaintext StartupMessage. */
const STARTUP_V3 = 196608;

/**
 * A fake Postgres server that records what each connection opened with,
 * answers SSLRequest with `reply`, and then hangs up - so no query ever runs.
 */
async function fakePostgres(reply: 'S' | 'N') {
  const openings: number[] = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (data) => {
      const code = data.length >= 8 ? data.readInt32BE(4) : -1;
      openings.push(code);
      if (code === SSL_REQUEST) {
        socket.write(reply);
        // After 'S' the client starts a TLS handshake we never complete.
        if (reply === 'S') socket.destroy();
      } else socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, openings, port: (server.address() as net.AddressInfo).port };
}

const servers: net.Server[] = [];
const managers: ConnectionPoolManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.closeAllPools()));
  for (const server of servers.splice(0)) server.close();
});

async function connectVia(reply: 'S' | 'N', properties: Record<string, string>) {
  const fake = await fakePostgres(reply);
  servers.push(fake.server);
  const manager = new ConnectionPoolManager({ acquireTimeoutMs: 2000 });
  managers.push(manager);
  const connection: DatabaseConnection = {
    id: `ssl-${reply}-${JSON.stringify(properties)}`,
    name: 'ssl',
    driver: 'postgresql',
    url: '',
    host: '127.0.0.1',
    port: fake.port,
    user: 'u',
    properties: { password: 'p', ...properties },
  };
  const entry = await manager.getPool(connection);
  const pool = entry!.pool as PgPool & { options: { ssl?: unknown } };
  await pool.connect().then(
    (client) => client.release(true),
    () => {}
  );
  return { openings: fake.openings, pool };
}

describe('Postgres sslmode=prefer semantics', () => {
  it('treats unset, prefer and allow as negotiable, and nothing else', () => {
    const c = (sslmode?: string): DatabaseConnection => ({
      id: 'c',
      name: 'c',
      driver: 'postgresql',
      url: '',
      properties: sslmode ? { sslmode } : {},
    });
    expect(postgresSslNegotiable(c())).toBe(true);
    expect(postgresSslNegotiable(c('prefer'))).toBe(true);
    expect(postgresSslNegotiable(c('allow'))).toBe(true);
    expect(postgresSslNegotiable(c('require'))).toBe(false);
    expect(postgresSslNegotiable(c('disable'))).toBe(false);
    expect(postgresSslNegotiable(c(), true)).toBe(false);
  });

  it('attempts TLS first, unverified, when the mode is unset', async () => {
    const { openings, pool } = await connectVia('S', {});
    expect(openings[0]).toBe(SSL_REQUEST);
    expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: false });
  });

  it('falls back to plaintext for that attempt only, then tries TLS again', async () => {
    const { openings, pool } = await connectVia('N', {});
    expect(openings).toEqual([SSL_REQUEST, STARTUP_V3]);
    expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: false });
    await pool.connect().then(
      (client) => client.release(true),
      () => {}
    );
    expect(openings).toEqual([SSL_REQUEST, STARTUP_V3, SSL_REQUEST, STARTUP_V3]);
  });

  it('never attempts TLS for disable', async () => {
    const { openings } = await connectVia('S', { sslmode: 'disable' });
    expect(openings).toEqual([STARTUP_V3]);
  });

  it('does not fall back to plaintext for require', async () => {
    const { openings, pool } = await connectVia('N', { sslmode: 'require' });
    expect(openings).toEqual([SSL_REQUEST]);
    expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: false });
  });
});

describe('Postgres statement timeout', () => {
  it('is set per session, not as a startup option RDS Proxy rejects', async () => {
    const { pool } = await connectVia('N', { sslmode: 'disable' });
    const options = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(options.statement_timeout).toBeUndefined();
    expect(pool.listenerCount('connect')).toBe(1);
  });
});
