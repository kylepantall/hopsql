import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfiguredConnections, loadConnectionOverrides } from '../src/connections-config.js';
import { WorkspaceConfigParser } from '../src/config-parser.js';
import { setEnv, restoreEnv } from './support/environment.js';

const dirs: string[] = [];
afterEach(() => {
  restoreEnv();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function configFile(config: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-ssm-config-'));
  dirs.push(dir);
  const file = path.join(dir, 'connections.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...config }), { mode: 0o600 });
  return file;
}

const ssm = { target: 'i-0123456789abcdef0', mode: 'port-forward', region: 'eu-west-2' };

describe('SSM connection config', () => {
  it('parses ssm on a configured connection', () => {
    const [c] = loadConfiguredConnections(
      configFile({ connections: { reports: { driver: 'postgres', host: 'db.internal', ssm } } })
    );
    expect(c.ssm).toEqual(ssm as never);
  });

  it('rejects malformed or option-like ssm values', () => {
    for (const bad of [
      { ...ssm, mode: 'tunnel' },
      { ...ssm, target: '--profile' },
      { ...ssm, region: 'eu-west-2; rm' },
      { ...ssm, profile: '-x' },
      { ...ssm, extra: true },
      { mode: 'ssh' },
    ])
      expect(() =>
        loadConfiguredConnections(
          configFile({ connections: { reports: { driver: 'postgres', ssm: bad } } })
        )
      ).toThrow();
  });

  it('loads overrides keyed by connection id or name', () => {
    const overrides = loadConnectionOverrides(
      configFile({ connections: {}, overrides: { 'postgres-jdbc-1': { ssm } } })
    );
    expect(overrides['postgres-jdbc-1'].ssm).toEqual(ssm as never);
    expect(() =>
      loadConnectionOverrides(configFile({ overrides: { x: { host: 'elsewhere' } } }))
    ).toThrow();
  });

  it('layers an override onto a discovered workspace connection', async () => {
    // A throwaway fixture workspace: never the real DBeaver data directory.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-ssm-workspace-'));
    dirs.push(workspace);
    const project = path.join(workspace, 'General', '.dbeaver');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, 'data-sources.json'),
      JSON.stringify({
        connections: {
          'postgres-jdbc-1': {
            name: 'Reporting',
            provider: 'postgresql',
            driver: 'postgres-jdbc',
            configuration: { host: 'db.internal', port: '5432', database: 'reports' },
          },
          'postgres-jdbc-2': {
            name: 'Other',
            provider: 'postgresql',
            driver: 'postgres-jdbc',
            configuration: { host: 'other.internal', port: '5432', database: 'other' },
          },
        },
      })
    );
    setEnv(
      'HOPSQL_CONFIG_FILE',
      configFile({ connections: {}, overrides: { Reporting: { ssm } } })
    );
    setEnv('HOPSQL_DISCOVER_WORKSPACE', 'true');
    const connections = await new WorkspaceConfigParser({
      workspacePath: workspace,
    }).parseConnections();
    const byName = Object.fromEntries(connections.map((c) => [c.name, c]));
    expect(byName.Reporting.ssm).toEqual(ssm as never);
    expect(byName.Other.ssm).toBeUndefined();
  });
});
