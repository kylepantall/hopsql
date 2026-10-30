import { afterEach, describe, expect, it, mock, vi } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const answers: unknown[] = [];
const prompt = () => answers.shift();
mock.module('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  log: { step: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn(), warn: vi.fn() },
  select: prompt,
  text: prompt,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
import { awsProfiles, runManage } from '../src/manage.js';
import { WorkspaceConfigParser } from '../src/config-parser.js';
import {
  loadManagedOverrides,
  loadManagedSettings,
  saveManagedOverrides,
} from '../src/connections-config.js';
import { setEnv, restoreEnv } from './support/environment.js';

const dirs: string[] = [];
afterEach(() => {
  restoreEnv();
  answers.splice(0);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A throwaway workspace and overrides file: never the real DBeaver data directory. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-manage-'));
  dirs.push(dir);
  const workspace = path.join(dir, 'workspace');
  const project = path.join(workspace, 'General', '.dbeaver');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'data-sources.json'),
    JSON.stringify({
      connections: {
        'pg-1': {
          name: 'Reporting',
          provider: 'postgresql',
          driver: 'postgres-jdbc',
          configuration: { host: 'localhost', port: '5432', database: 'reports' },
        },
      },
    })
  );
  const overrides = path.join(dir, 'overrides.json');
  setEnv('HOPSQL_WORKSPACE', workspace);
  setEnv('HOPSQL_OVERRIDES_FILE', overrides);
  setEnv('HOPSQL_CONFIG_FILE', undefined);
  setEnv('AWS_CONFIG_FILE', path.join(dir, 'no-aws-config'));
  setEnv('AWS_SHARED_CREDENTIALS_FILE', path.join(dir, 'no-aws-credentials'));
  const parse = async () =>
    (await new WorkspaceConfigParser({ workspacePath: workspace }).parseConnections())[0];
  return { dir, overrides, parse };
}

describe('hopsql manage', () => {
  it('toggles read-only and the running server sees it on the next lookup', async () => {
    const { overrides, parse } = fixture();
    expect((await parse()).readonly).toBe(false);
    answers.push('pg-1', 'readOnly', '');
    await runManage();
    expect(answers).toHaveLength(0);
    expect(loadManagedOverrides(overrides)['pg-1']).toEqual({ readOnly: true });
    expect((await parse()).readonly).toBe(true);
    expect(fs.statSync(overrides).mode & 0o077).toBe(0);
  });

  it('sets up an SSM hop with a Secrets Manager login, then removes it', async () => {
    const { overrides, parse } = fixture();
    answers.push(
      'pg-1',
      'ssm',
      'targetName',
      'prod-bastion',
      'port-forward',
      'eu-west-2',
      // No AWS profiles exist in the fixture, so the profile is typed.
      'prod',
      'db.proxy.internal',
      '5432',
      'prod/ReportingCluster',
      ''
    );
    await runManage();
    expect(answers).toHaveLength(0);
    const connection = await parse();
    expect(connection.ssm).toEqual({
      targetName: 'prod-bastion',
      mode: 'port-forward',
      region: 'eu-west-2',
      profile: 'prod',
      remoteHost: 'db.proxy.internal',
      remotePort: 5432,
    });
    expect(connection.awsSecret).toEqual({ secretId: 'prod/ReportingCluster' });

    answers.push('pg-1', 'removeSsm', '');
    await runManage();
    expect(loadManagedOverrides(overrides)).toEqual({});
    expect((await parse()).ssm).toBeUndefined();
  });

  it('refuses invalid SSM values without writing anything', async () => {
    const { overrides } = fixture();
    answers.push('pg-1', 'ssm', 'targetName', 'a,Values=b', 'port-forward', '', '', '', '', '');
    await expect(runManage()).rejects.toThrow();
    expect(fs.existsSync(overrides)).toBe(false);
  });

  it('wins over the config file overrides', async () => {
    const { dir, overrides, parse } = fixture();
    const config = path.join(dir, 'connections.json');
    fs.writeFileSync(
      config,
      JSON.stringify({ version: 1, connections: {}, overrides: { 'pg-1': { readOnly: true } } }),
      { mode: 0o600 }
    );
    setEnv('HOPSQL_CONFIG_FILE', config);
    setEnv('HOPSQL_DISCOVER_WORKSPACE', 'true');
    expect((await parse()).readonly).toBe(true);
    saveManagedOverrides({ 'pg-1': { readOnly: false } }, overrides);
    expect((await parse()).readonly).toBe(false);
  });

  it('sets the dump folder without losing connection overrides', async () => {
    const { dir, overrides } = fixture();
    const folder = path.join(dir, 'dumps');
    answers.push('pg-1', 'readOnly', '\0tools', 'folder', folder, '', '');
    await runManage();
    expect(answers).toHaveLength(0);
    expect(loadManagedSettings(overrides).dumpDirectory).toBe(folder);
    expect(loadManagedOverrides(overrides)['pg-1']).toEqual({ readOnly: true });
  });

  it('lists AWS profiles from config and credentials, skipping sso-session blocks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-aws-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'config'),
      '[default]\n[profile prod]\n[sso-session corp]\nsso_region = eu-west-2\n'
    );
    fs.writeFileSync(path.join(dir, 'credentials'), '[legacy]\n');
    expect(
      awsProfiles(dir, {
        AWS_CONFIG_FILE: path.join(dir, 'config'),
        AWS_SHARED_CREDENTIALS_FILE: path.join(dir, 'credentials'),
      })
    ).toEqual(['default', 'legacy', 'prod']);
  });
});
