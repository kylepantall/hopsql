import { afterEach, describe, expect, it, vi } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS, diagnose, probe, runDoctor } from '../src/doctor.js';
import type { DatabaseConnection } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const connection = (name: string, extra: Partial<DatabaseConnection>): DatabaseConnection => ({
  id: name,
  name,
  driver: 'sqlite',
  url: '',
  ...extra,
});
const sqlite = connection('local', { driver: 'sqlite' });
const prod = connection('prod', {
  driver: 'postgresql',
  ssm: { target: 'i-0123456789abcdef0', mode: 'port-forward' },
});
const shop = connection('shop', { driver: 'mysql' });

/** Every tool reported missing, so results do not depend on this machine. */
const missingTools = TOOLS.map((tool) => ({ ...tool, locate: () => null }));
const byName = (reports: ReturnType<typeof diagnose>) =>
  Object.fromEntries(reports.map((r) => [r.name, r]));

describe('hopsql doctor', () => {
  it('marks tools required only when a configured connection needs them', () => {
    const reports = byName(diagnose([sqlite, prod, shop], missingTools, 'darwin'));
    expect(reports['sqlite3']).toMatchObject({ required: true, neededBy: ['local'] });
    expect(reports['aws']).toMatchObject({ required: true, neededBy: ['prod'] });
    expect(reports['session-manager-plugin']).toMatchObject({ required: true });
    expect(reports['duckdb']).toMatchObject({ required: false, neededBy: [] });
    // Dumps are a feature, never a requirement, but list who could use them.
    expect(reports['pg_dump']).toMatchObject({ required: false, neededBy: ['prod'] });
    expect(reports['mysqldump / mariadb-dump']).toMatchObject({
      required: false,
      neededBy: ['shop'],
    });
  });

  it('gives a platform-specific install hint only for missing tools', () => {
    const mac = byName(diagnose([], missingTools, 'darwin'));
    const linux = byName(diagnose([], missingTools, 'linux'));
    const windows = byName(diagnose([], missingTools, 'win32'));
    expect(mac['sqlite3'].installHint).toContain('brew');
    expect(linux['sqlite3'].installHint).toContain('apt');
    expect(windows['sqlite3'].installHint).toContain('winget');
    const found = TOOLS.map((tool) => ({
      ...tool,
      locate: () => ({ path: '/usr/bin/x', version: '1.0' }),
    }));
    for (const report of diagnose([sqlite], found)) {
      expect(report.found).toBe(true);
      expect(report.installHint).toBeUndefined();
    }
  });

  it.skipIf(process.platform === 'win32')('probes a tool and reads its version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-doctor-'));
    dirs.push(dir);
    const tool = path.join(dir, 'fake-tool');
    fs.writeFileSync(tool, '#!/bin/sh\necho "fake-tool 3.45.1 2024-01-30"\n', { mode: 0o755 });
    expect(probe(tool, '--version')).toEqual({ path: tool, version: '3.45.1' });
    const failing = path.join(dir, 'failing-tool');
    fs.writeFileSync(failing, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    expect(probe(failing, '--version')).toBeNull();
    expect(probe(path.join(dir, 'missing'), '--version')).toBeNull();
  });

  it('never fails without --strict, and reports when configuration is missing', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(
        await runDoctor(['--json'], async () => {
          throw new Error('no config');
        })
      ).toBe(0);
      const output = JSON.parse(String(stdout.mock.calls.at(-1)![0]));
      expect(output.connectionsLoaded).toBe(false);
      expect(output.tools.every((t: { required: boolean }) => !t.required)).toBe(true);
      await expect(runDoctor(['--bogus'], async () => [])).rejects.toThrow();
    } finally {
      stdout.mockRestore();
    }
  });

  it('--strict exits non-zero only when a required tool is missing', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      // duckdb is never installed in CI and nothing here needs it.
      expect(await runDoctor(['--strict'], async () => [])).toBe(0);
      const duck = connection('analytics', {
        driver: 'duckdb',
        properties: { database: ':memory:' },
      });
      const exit = await runDoctor(['--strict', '--json'], async () => [duck]);
      const output = JSON.parse(String(stdout.mock.calls.at(-1)![0]));
      const duckdb = output.tools.find((t: { name: string }) => t.name === 'duckdb');
      expect(duckdb.required).toBe(true);
      expect(exit).toBe(duckdb.found ? 0 : 1);
    } finally {
      stdout.mockRestore();
    }
  });
});
