import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOverride, loadConnectionOverrides } from '../src/connections-config.js';
import { SshTunnelManager } from '../src/net/ssh-tunnel.js';
import { probeTarget } from '../src/net/vpn.js';
import type { DatabaseConnection, SshTunnelConfig } from '../src/types.js';
import { fixtures, roundTrip, startEchoServer, startSshServer } from './support/ssh-fixtures.js';

const dirs: string[] = [];
const f = fixtures();
afterEach(() => {
  f.run();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function load(override: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-ssh-override-'));
  dirs.push(dir);
  const file = path.join(dir, 'overrides.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, overrides: { db: override } }), {
    mode: 0o600,
  });
  return loadConnectionOverrides(file).db;
}

const bastion: SshTunnelConfig = {
  enabled: true,
  host: 'bastion.example.com',
  port: 2222,
  user: 'jump',
  authType: 'PUBLIC_KEY',
  privateKeyPath: '~/.ssh/bastion',
};
const tunnel: SshTunnelConfig = {
  enabled: true,
  host: 'app.internal',
  port: 22,
  user: 'deploy',
  authType: 'PASSWORD',
  password: 'saved-in-dbeaver',
  connectTimeoutMs: 5000,
  jumpHosts: [bastion],
};
const connection: DatabaseConnection = {
  id: 'db',
  name: 'db',
  driver: 'postgres',
  url: '',
  host: 'localhost',
  port: 5432,
  sshTunnel: tunnel,
};

describe('ssh override parsing', () => {
  it('accepts each shape', () => {
    for (const ssh of [
      { enabled: false },
      { jumpHosts: [] },
      { host: 'app.example.com', port: 22, user: 'ec2-user' },
      { jumpHosts: [{ host: '10.0.0.5', port: 22, user: 'jump' }, { host: 'b2' }] },
      { enabled: true },
    ])
      expect(load({ ssh }).ssh).toEqual(ssh);
  });

  it('rejects unknown keys, credentials and option-like values', () => {
    for (const ssh of [
      {},
      { password: 'x' },
      { privateKeyPath: '/k' },
      { host: '-oProxyCommand=x' },
      { user: '-x' },
      { host: 'a b' },
      { port: 0 },
      { port: '22' },
      { enabled: 'no' },
      { enabled: false, host: 'a' },
      { jumpHosts: {} },
      { jumpHosts: [{}] },
      { jumpHosts: [{ host: 'a', password: 'x' }] },
      { jumpHosts: [{ host: '-J' }] },
      { jumpHosts: Array.from({ length: 9 }, () => ({ host: 'a' })) },
    ])
      expect(() => load({ ssh })).toThrow();
  });

  it('refuses ssh with an ssm hop that contradicts it', () => {
    const ssm = { target: 'i-0123456789abcdef0', region: 'eu-west-2' };
    expect(() => load({ ssm: { ...ssm, mode: 'port-forward' }, ssh: { jumpHosts: [] } })).toThrow();
    expect(() => load({ ssm: { ...ssm, mode: 'ssh' }, ssh: { enabled: false } })).toThrow();
    // SSM carries the first hop of whatever route ssh leaves.
    expect(load({ ssm: { ...ssm, mode: 'ssh' }, ssh: { jumpHosts: [] } }).ssh).toEqual({
      jumpHosts: [],
    });
  });
});

describe('applyOverride with ssh', () => {
  it('drops the bastions but keeps the final hop', () => {
    const result = applyOverride(connection, { ssh: { jumpHosts: [] } }).sshTunnel!;
    expect(result.jumpHosts).toEqual([]);
    expect({ ...result, jumpHosts: tunnel.jumpHosts }).toEqual(tunnel);
  });

  it('drops the tunnel with enabled false', () => {
    const result = applyOverride(connection, { ssh: { enabled: false } });
    expect(result.sshTunnel?.enabled).toBe(false);
    expect(probeTarget(result, 5432)).toEqual({ host: 'localhost', port: 5432 });
  });

  it('replaces the final host and keeps DBeaver auth', () => {
    const result = applyOverride(connection, {
      ssh: { host: 'app.example.com', user: 'ec2-user', jumpHosts: [] },
    }).sshTunnel!;
    expect(result).toMatchObject({
      enabled: true,
      host: 'app.example.com',
      port: 22,
      user: 'ec2-user',
      authType: 'PASSWORD',
      password: 'saved-in-dbeaver',
    });
  });

  it('replaces bastions: a known host keeps its auth, a new one uses the agent', () => {
    const result = applyOverride(connection, {
      ssh: { jumpHosts: [{ host: 'new-bastion' }, { host: 'bastion.example.com' }] },
    }).sshTunnel!;
    expect(result.jumpHosts).toEqual([
      {
        enabled: true,
        host: 'new-bastion',
        port: 22,
        user: 'deploy',
        authType: 'AGENT',
        connectTimeoutMs: 5000,
      },
      {
        enabled: true,
        host: 'bastion.example.com',
        port: 2222,
        user: 'jump',
        authType: 'PUBLIC_KEY',
        privateKeyPath: '~/.ssh/bastion',
        connectTimeoutMs: 5000,
      },
    ]);
    expect(probeTarget(applyOverride(connection, { ssh: { jumpHosts: [] } }), 5432)).toEqual({
      host: 'app.internal',
      port: 22,
    });
  });

  it('adds a tunnel to a direct connection only when a host is given', () => {
    const direct = { ...connection, sshTunnel: undefined };
    expect(applyOverride(direct, { ssh: { jumpHosts: [] } }).sshTunnel).toBeUndefined();
    expect(applyOverride(direct, { ssh: { host: 'app', user: 'me' } }).sshTunnel).toEqual({
      enabled: true,
      host: 'app',
      port: 22,
      user: 'me',
    });
  });

  it('keeps a tunnel DBeaver switched off unless enabled is set', () => {
    const off = { ...connection, sshTunnel: { ...tunnel, enabled: false } };
    expect(applyOverride(off, { ssh: { jumpHosts: [] } }).sshTunnel?.enabled).toBe(false);
    expect(applyOverride(off, { ssh: { enabled: true } }).sshTunnel?.enabled).toBe(true);
  });
});

describe('SshTunnelManager with an ssh override', () => {
  async function setup() {
    const dbPort = await startEchoServer(f);
    const ssh = await startSshServer(f);
    const manager = new SshTunnelManager();
    f.cleanups.push(() => void manager.closeAll());
    // DBeaver's bastion is unreachable, so only an override can connect.
    const dbeaver: DatabaseConnection = {
      ...connection,
      host: '127.0.0.1',
      port: dbPort,
      sshTunnel: {
        enabled: true,
        host: '127.0.0.1',
        port: ssh.port,
        user: 'inner',
        authType: 'PASSWORD',
        password: 'p',
        connectTimeoutMs: 2000,
        jumpHosts: [
          { ...bastion, host: '127.0.0.1', port: 1, authType: 'PASSWORD', password: 'p' },
        ],
      },
    };
    return { manager, ssh, dbeaver };
  }

  it('dials the final host directly when bastions are dropped', async () => {
    const { manager, ssh, dbeaver } = await setup();
    const endpoint = await manager.resolveEndpoint(
      applyOverride(dbeaver, { ssh: { jumpHosts: [] } }),
      5432
    );
    expect(await roundTrip(endpoint!.port)).toBe('ping');
    expect(ssh.clients.size).toBe(1);
  }, 20000);

  it('routes through a replacement bastion', async () => {
    const { manager, ssh, dbeaver } = await setup();
    const endpoint = await manager.resolveEndpoint(
      applyOverride(dbeaver, {
        ssh: { jumpHosts: [{ host: '127.0.0.1', port: ssh.port, user: 'bastion' }] },
      }),
      5432
    );
    expect(await roundTrip(endpoint!.port)).toBe('ping');
    // The same server plays bastion and final hop: two SSH sessions.
    expect(ssh.clients.size).toBe(2);
  }, 20000);

  it('opens no tunnel when the override disables it', async () => {
    const { manager, dbeaver } = await setup();
    expect(
      await manager.resolveEndpoint(applyOverride(dbeaver, { ssh: { enabled: false } }), 5432)
    ).toBeNull();
  });
});
