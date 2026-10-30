import { afterEach, describe, expect, it, mock, vi } from 'bun:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const answers: unknown[] = [];
const prompt = () => answers.shift();
mock.module('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  log: { step: vi.fn(), success: vi.fn(), message: vi.fn() },
  select: prompt,
  multiselect: prompt,
  text: prompt,
  password: prompt,
  confirm: prompt,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
mock.module('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
import { spawnSync } from 'node:child_process';
import { runInstall } from '../src/install.js';
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  answers.splice(0);
  directories
    .splice(0)
    .forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
});

describe('guided direct setup', () => {
  it('registers multiple instances with distinct policies and private masked credentials', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'hopsql-wizard-'));
    directories.push(directory);
    const file = join(directory, 'private setup.json');
    vi.spyOn(process.stdin, 'isTTY', 'get').mockReturnValue(true);
    vi.spyOn(process.stdout, 'isTTY', 'get').mockReturnValue(true);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const priorHome = process.env.CODEX_HOME;
    const priorWorkspace = process.env.HOPSQL_WORKSPACE;
    process.env.CODEX_HOME = join(directory, 'codex');
    // Keeps workspace detection inside the fixture directory.
    process.env.HOPSQL_WORKSPACE = directory;
    const fixture = join(directory, 'fixture.db');
    fs.writeFileSync(fixture, '');
    answers.push(
      'codex',
      'direct',
      // sqlite: engine, file, ID, read-only, table access
      'sqlite',
      fixture,
      'local',
      true,
      'allowTables',
      'public.*',
      true,
      // postgresql: engine, host, port, user, credentials, password, TLS, database, ID, read-only, tables
      'postgresql',
      'localhost',
      '5432',
      'reader',
      'private',
      'masked-synthetic-fixture',
      true,
      'warehouse',
      'analytics',
      false,
      'denyTables',
      'public.private',
      false,
      file
    );
    try {
      await runInstall([]);
      expect(answers).toHaveLength(0);
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(config.connections.local.readOnly).toBe(true);
      expect(config.connections.local.policy).toEqual({ allowTables: ['public.*'] });
      expect(config.connections.analytics.policy).toEqual({ denyTables: ['public.private'] });
      expect(config.connections.analytics.readOnly).toBe(false);
      expect(config.connections.analytics.properties.sslmode).toBe('verify-full');
      expect(config.connections.analytics.properties.password).toBe('masked-synthetic-fixture');
      expect(JSON.stringify(spawnSync.mock.calls)).not.toContain('masked-synthetic-fixture');
      expect(stderr.mock.calls.flat().join(' ')).not.toContain('masked-synthetic-fixture');
      const registration = spawnSync.mock.calls.at(-1)!;
      expect(registration[1]).toContain('HOPSQL_ALLOWED_CONNECTIONS=local,analytics');
      expect(registration[1]).toContain('HOPSQL_DISCOVER_WORKSPACE=false');
      expect(registration[1]).toContain('HOPSQL_READ_ONLY=false');
    } finally {
      if (priorHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorHome;
      if (priorWorkspace === undefined) delete process.env.HOPSQL_WORKSPACE;
      else process.env.HOPSQL_WORKSPACE = priorWorkspace;
    }
  });
  it('offers the detected workspace and a checklist of its connections', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'hopsql-pick-'));
    directories.push(directory);
    const workspace = join(directory, 'workspace');
    const project = join(workspace, 'General', '.dbeaver');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      join(project, 'data-sources.json'),
      JSON.stringify({
        connections: {
          picked: { name: 'Picked', driver: 'sqlite', configuration: { database: '/a.db' } },
          skipped: { name: 'Skipped', driver: 'sqlite', configuration: { database: '/b.db' } },
        },
      })
    );
    vi.spyOn(process.stdin, 'isTTY', 'get').mockReturnValue(true);
    vi.spyOn(process.stdout, 'isTTY', 'get').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const saved = { home: process.env.CODEX_HOME, workspace: process.env.HOPSQL_WORKSPACE };
    process.env.CODEX_HOME = join(directory, 'codex');
    process.env.HOPSQL_WORKSPACE = workspace;
    // client, source, detected workspace (picked from the list), connections, read-only
    answers.push('codex', 'workspace', workspace, ['picked'], true);
    try {
      await runInstall([]);
      expect(answers).toHaveLength(0);
      const registration = spawnSync.mock.calls.at(-1)!;
      expect(registration[1]).toContain('HOPSQL_ALLOWED_CONNECTIONS=picked');
      expect(registration[1]).toContain(`HOPSQL_WORKSPACE=${workspace}`);
    } finally {
      for (const [key, value] of [
        ['CODEX_HOME', saved.home],
        ['HOPSQL_WORKSPACE', saved.workspace],
      ] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
  it('validates selected workspace IDs without reading an inherited direct config', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'hopsql-workspace-'));
    directories.push(directory);
    const project = join(directory, 'workspace', 'General', '.dbeaver');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      join(project, 'data-sources.json'),
      JSON.stringify({
        connections: {
          selected: {
            name: 'selected',
            driver: 'sqlite',
            configuration: { database: '/fixture.db' },
          },
        },
      })
    );
    const previousConfig = process.env.HOPSQL_CONFIG_FILE,
      previousDiscovery = process.env.HOPSQL_DISCOVER_WORKSPACE,
      previousHome = process.env.CODEX_HOME;
    process.env.HOPSQL_CONFIG_FILE = join(directory, 'unrelated-private-config.json');
    process.env.HOPSQL_DISCOVER_WORKSPACE = 'false';
    process.env.CODEX_HOME = join(directory, 'codex');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runInstall([
        'codex',
        '--workspace',
        join(directory, 'workspace'),
        '--allow',
        'selected',
      ]);
      expect(process.env.HOPSQL_CONFIG_FILE).toBe(join(directory, 'unrelated-private-config.json'));
      expect(process.env.HOPSQL_DISCOVER_WORKSPACE).toBe('false');
      await expect(
        runInstall(['codex', '--workspace', join(directory, 'workspace'), '--allow', 'missing'])
      ).rejects.toThrow(/existing workspace/);
    } finally {
      for (const [key, value] of [
        ['HOPSQL_CONFIG_FILE', previousConfig],
        ['HOPSQL_DISCOVER_WORKSPACE', previousDiscovery],
        ['CODEX_HOME', previousHome],
      ])
        if (value === undefined) delete process.env[key!];
        else process.env[key!] = value;
    }
  });
});
