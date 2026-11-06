import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyOverride,
  loadConfiguredConnections,
  loadConnectionOverrides,
  loadManagedOverrides,
  parseVpn,
  saveManagedOverrides,
} from '../src/connections-config.js';
import {
  matchProfile,
  parseProfileList,
  probeTarget,
  VpnManager,
  type CommandRunner,
  type Launched,
  type ProbeTarget,
} from '../src/net/vpn.js';
import { setVpn } from '../src/vpn-cli.js';
import type { DatabaseConnection, VpnConfig } from '../src/types.js';
import { setEnv, restoreEnv } from './support/environment.js';

const dirs: string[] = [];
afterEach(() => {
  restoreEnv();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-vpn-'));
  dirs.push(dir);
  return dir;
}

function configFile(config: object): string {
  const file = path.join(tempDir(), 'connections.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...config }), { mode: 0o600 });
  return file;
}

const openvpn: VpnConfig = { provider: 'openvpn-connect', profile: 'Work' };
const command: VpnConfig = {
  provider: 'command',
  up: ['wg-quick', 'up', 'wg0'],
  down: ['wg-quick', 'down', 'wg0'],
};

function connection(extra: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'db',
    name: 'db',
    driver: 'postgres',
    url: '',
    host: 'db.internal',
    port: 5432,
    ...extra,
  };
}

describe('VPN config', () => {
  it('parses both providers on a configured connection', () => {
    const [a, b] = loadConfiguredConnections(
      configFile({
        connections: {
          a: { driver: 'postgres', host: 'db', vpn: { ...openvpn, connectTimeoutMs: 5000 } },
          b: { driver: 'postgres', host: 'db', vpn: { ...command, check: ['true'] } },
        },
      })
    );
    expect(a.vpn).toEqual({ ...openvpn, connectTimeoutMs: 5000 });
    expect(b.vpn).toEqual({ ...command, check: ['true'] });
  });

  it('layers a vpn override onto a discovered connection', () => {
    const overrides = loadConnectionOverrides(configFile({ overrides: { db: { vpn: openvpn } } }));
    expect(applyOverride(connection(), overrides.db).vpn).toEqual(openvpn);
  });

  it('rejects malformed vpn settings', () => {
    for (const bad of [
      { provider: 'tunnelblick', profile: 'x' },
      { provider: 'openvpn-connect', profile: '--quit' },
      { provider: 'openvpn-connect', profile: '' },
      { provider: 'openvpn-connect', profile: 'x', up: ['a'] },
      { provider: 'command', up: [] },
      { provider: 'command', up: 'wg-quick up' },
      { provider: 'command', up: [''] },
      { provider: 'command', up: ['a'], down: [1] },
      { provider: 'openvpn-connect', profile: 'x', connectTimeoutMs: 10 },
      { provider: 'openvpn-connect', profile: 'x', disconnectOnExit: 'yes' },
    ])
      expect(() => parseVpn(bad, 'Connection db')).toThrow();
  });
});

describe('OpenVPN Connect profiles', () => {
  const profiles = [
    { id: '111', name: 'vpn.example.com [kyle 1]' },
    { id: '222', name: 'cvpn-endpoint.prod [kyle]' },
  ];

  it('reads the JSON list despite surrounding output', () => {
    expect(
      parseProfileList(`noise\n${JSON.stringify([{ id: 111, name: 'a', host: 'h' }])}\n`)
    ).toEqual([{ id: '111', name: 'a' }]);
    expect(() => parseProfileList('unknown option')).toThrow();
  });

  it('matches by id, name, case-insensitive name, or a unique fragment', () => {
    expect(matchProfile(profiles, '222').id).toBe('222');
    expect(matchProfile(profiles, 'vpn.example.com [kyle 1]').id).toBe('111');
    expect(matchProfile(profiles, 'VPN.EXAMPLE.COM [KYLE 1]').id).toBe('111');
    expect(matchProfile(profiles, 'cvpn').id).toBe('222');
    expect(() => matchProfile(profiles, 'kyle')).toThrow();
    expect(() => matchProfile(profiles, 'nothing')).toThrow();
  });
});

describe('probeTarget', () => {
  it('is the outermost SSH hop, else the database, and none for SSM', () => {
    const ssh = { enabled: true, host: 'bastion', port: 2222 };
    expect(probeTarget(connection({ sshTunnel: ssh }), 5432)).toEqual({
      host: 'bastion',
      port: 2222,
    });
    expect(
      probeTarget(
        connection({
          sshTunnel: { ...ssh, jumpHosts: [{ enabled: true, host: 'jump', port: 0 }] },
        }),
        5432
      )
    ).toEqual({ host: 'jump', port: 22 });
    expect(probeTarget(connection({ port: undefined }), 5432)).toEqual({
      host: 'db.internal',
      port: 5432,
    });
    expect(
      probeTarget(connection({ ssm: { target: 'i-1', mode: 'port-forward' } }), 5432)
    ).toBeNull();
  });
});

/** A VPN whose reachability flips once the launched client has run. */
function harness(
  options: { upAfterPolls?: number; exitCode?: number | null; initiallyUp?: boolean } = {}
) {
  let clock = 0;
  let up = options.initiallyUp ?? false;
  let polls = 0;
  const launches: string[][] = [];
  const runs: string[][] = [];
  const probes: ProbeTarget[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    runs.push([cmd, ...args]);
    if (args[0] === '--list-profiles')
      return { code: 0, stdout: JSON.stringify([{ id: '42', name: 'Work' }]), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const manager = new VpnManager({
    runner,
    launcher: (cmd, args): Launched => {
      launches.push([cmd, ...args]);
      return { exitCode: () => options.exitCode, stderr: () => 'boom', release: () => {} };
    },
    probe: async (target) => {
      probes.push(target);
      if (launches.length && ++polls > (options.upAfterPolls ?? 1)) up = true;
      return up;
    },
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  });
  return { manager, launches, runs, probes };
}

describe('VpnManager', () => {
  it('does nothing when the host is already reachable', async () => {
    const h = harness({ initiallyUp: true });
    await h.manager.ensure(connection({ vpn: command }), 5432);
    expect(h.launches).toHaveLength(0);
    await h.manager.disconnectAll();
    expect(h.runs).toHaveLength(0);
  });

  it('starts the VPN, waits for the host, and takes it down on exit', async () => {
    const h = harness({ upAfterPolls: 2 });
    await h.manager.ensure(connection({ vpn: command }), 5432);
    expect(h.launches).toEqual([['wg-quick', 'up', 'wg0']]);
    expect(h.probes.at(-1)).toEqual({ host: 'db.internal', port: 5432 });
    await h.manager.disconnectAll();
    expect(h.runs).toEqual([['wg-quick', 'down', 'wg0']]);
  });

  it('leaves the VPN up when disconnectOnExit is false', async () => {
    const h = harness();
    await h.manager.ensure(connection({ vpn: { ...command, disconnectOnExit: false } }), 5432);
    await h.manager.disconnectAll();
    expect(h.runs).toHaveLength(0);
  });

  it('shares one start between concurrent connections and skips re-probing soon after', async () => {
    const h = harness();
    await Promise.all([
      h.manager.ensure(connection({ vpn: command }), 5432),
      h.manager.ensure(connection({ id: 'other', vpn: command }), 5432),
    ]);
    const probes = h.probes.length;
    await h.manager.ensure(connection({ vpn: command }), 5432);
    expect(h.launches).toHaveLength(1);
    expect(h.probes).toHaveLength(probes);
  });

  it('fails fast when the client exits non-zero', async () => {
    const h = harness({ exitCode: 1, upAfterPolls: 99 });
    await expect(h.manager.ensure(connection({ vpn: command }), 5432)).rejects.toThrow();
  });

  it('gives up after connectTimeoutMs', async () => {
    const h = harness({ upAfterPolls: Infinity });
    await expect(
      h.manager.ensure(connection({ vpn: { ...command, connectTimeoutMs: 3000 } }), 5432)
    ).rejects.toThrow();
  });

  it('uses a check command instead of probing when configured', async () => {
    const h = harness();
    await h.manager.ensure(connection({ vpn: { ...command, check: ['true'] } }), 5432);
    expect(h.probes).toHaveLength(0);
    expect(h.runs[0]).toEqual(['true']);
    expect(h.launches).toHaveLength(0);
  });

  it('connects OpenVPN Connect by the matched profile id and disconnects it', async () => {
    const exe = path.join(tempDir(), 'OpenVPNConnect');
    fs.writeFileSync(exe, '');
    setEnv('HOPSQL_OPENVPN_CONNECT', exe);
    const h = harness();
    await h.manager.ensure(connection({ vpn: openvpn }), 5432);
    expect(h.launches).toEqual([[exe, '--connect-shortcut=42']]);
    await h.manager.disconnectAll();
    expect(h.runs.at(-1)).toEqual([exe, '--disconnect-shortcut']);
  });
});

describe('setVpn', () => {
  it('sets and clears a connection vpn while keeping its other settings', () => {
    const file = path.join(tempDir(), 'overrides.json');
    saveManagedOverrides({ db: { access: 'ask' } }, file);
    setVpn([connection()], openvpn, file);
    expect(loadManagedOverrides(file).db).toEqual({ access: 'ask', vpn: openvpn });
    setVpn([connection()], undefined, file);
    expect(loadManagedOverrides(file).db).toEqual({ access: 'ask' });
  });
});
