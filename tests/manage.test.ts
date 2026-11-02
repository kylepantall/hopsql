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
  multiselect: prompt,
  text: prompt,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
import { awsProfiles, runAccessCommand, runManage } from '../src/manage.js';
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
        'pg-2': {
          name: 'Billing',
          provider: 'postgresql',
          driver: 'postgres-jdbc',
          configuration: { host: 'localhost', port: '5432', database: 'billing' },
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
  const parseAll = async () =>
    new WorkspaceConfigParser({ workspacePath: workspace }).parseConnections();
  const parse = async () => (await parseAll()).find((c) => c.id === 'pg-1')!;
  return { dir, overrides, parse, parseAll };
}

describe('hopsql manage', () => {
  it('sets access and the running server sees it on the next lookup', async () => {
    const { overrides, parse } = fixture();
    expect((await parse()).readonly).toBe(false);
    answers.push('pg-1', 'access', 'read-only', '');
    await runManage();
    expect(answers).toHaveLength(0);
    expect(loadManagedOverrides(overrides)['pg-1']).toEqual({ access: 'read-only' });
    expect(await parse()).toMatchObject({ readonly: true, accessManaged: true });
    expect(fs.statSync(overrides).mode & 0o077).toBe(0);

    answers.push('pg-1', 'access', 'ask', '');
    await runManage();
    expect(await parse()).toMatchObject({ readonly: false, askBeforeWrite: true });

    answers.push('pg-1', 'access', 'reset', '');
    await runManage();
    const reset = await parse();
    expect(reset.readonly).toBe(false);
    expect(reset.accessManaged).toBeUndefined();
  });

  it('changes several connections at once from the menu', async () => {
    const { overrides, parseAll } = fixture();
    answers.push('\0bulk', ['pg-1', 'pg-2'], 'ask', '');
    await runManage();
    expect(answers).toHaveLength(0);
    expect(loadManagedOverrides(overrides)).toEqual({
      'pg-1': { access: 'ask' },
      'pg-2': { access: 'ask' },
    });
    expect((await parseAll()).every((c) => c.askBeforeWrite)).toBe(true);
  });

  it('hopsql access changes connections by id or name, or all of them', async () => {
    const { overrides } = fixture();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runAccessCommand(['writable', 'pg-1', 'Billing']);
      expect(loadManagedOverrides(overrides)).toEqual({
        'pg-1': { access: 'writable' },
        'pg-2': { access: 'writable' },
      });
      await runAccessCommand(['read-only', '--all']);
      expect(
        Object.values(loadManagedOverrides(overrides)).every((o) => o.access === 'read-only')
      ).toBe(true);
      await runAccessCommand([]);
      expect(stdout).toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it('hopsql access changes nothing when a connection is unknown or the mode is invalid', async () => {
    const { overrides } = fixture();
    await expect(runAccessCommand(['writable', 'pg-1', 'nope'])).rejects.toThrow();
    await expect(runAccessCommand(['sometimes', 'pg-1'])).rejects.toThrow();
    await expect(runAccessCommand(['writable'])).rejects.toThrow();
    expect(fs.existsSync(overrides)).toBe(false);
  });

  it('migrates the older readOnly key when access is set', async () => {
    const { overrides, parse } = fixture();
    saveManagedOverrides({ 'pg-1': { readOnly: true } }, overrides);
    expect(await parse()).toMatchObject({ readonly: true, accessManaged: true });
    await runAccessCommand(['ask', 'pg-1']);
    expect(loadManagedOverrides(overrides)['pg-1']).toEqual({ access: 'ask' });
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
    answers.push('pg-1', 'access', 'read-only', '\0tools', 'folder', folder, '', '');
    await runManage();
    expect(answers).toHaveLength(0);
    expect(loadManagedSettings(overrides).dumpDirectory).toBe(folder);
    expect(loadManagedOverrides(overrides)['pg-1']).toEqual({ access: 'read-only' });
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
