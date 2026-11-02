import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DumpError,
  createDumpFile,
  dumpDirectory,
  dumpToolVersion,
  findDumpCandidates,
  resolveDumpBinary,
} from '../src/runtime/dump.js';
import { loadManagedSettings, saveManagedSettings } from '../src/connections-config.js';
import { setEnv, restoreEnv } from './support/environment.js';

const dirs: string[] = [];
afterEach(() => {
  restoreEnv();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempDir(prefix = 'hopsql-dump-tools-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A fake client that prints a version line like the real one. */
function fakeTool(dir: string, name: string, versionLine: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${versionLine}"\n`, { mode: 0o755 });
  return file;
}

describe.skipIf(process.platform === 'win32')('dump client discovery', () => {
  it('prefers the newest pg_dump across PATH and install folders', () => {
    const root = tempDir();
    const old = fakeTool(path.join(root, 'old'), 'pg_dump', 'pg_dump (PostgreSQL) 14.11');
    const fresh = fakeTool(path.join(root, 'new'), 'pg_dump', 'pg_dump (PostgreSQL) 17.2');
    const found = findDumpCandidates('postgres', { PATH: path.dirname(old) }, 'darwin', [
      path.dirname(fresh),
    ]);
    expect(found.map((c) => c.path)).toEqual([fresh, old]);
    expect(found[0].version).toEqual([17, 2]);
  });

  it('keeps the MariaDB name preference ahead of version', () => {
    const root = tempDir();
    const maria = fakeTool(root, 'mariadb-dump', 'mariadb-dump  Ver 10.11 Distrib 10.11.6-MariaDB');
    fakeTool(root, 'mysqldump', 'mysqldump  Ver 8.4.0 for macos');
    expect(findDumpCandidates('mariadb', { PATH: root }, 'darwin', [])[0].path).toBe(maria);
    expect(resolveDumpBinary('mariadb', { PATH: root }).path).toBe(maria);
  });

  it('reads the client version, not a number from the platform name', () => {
    const root = tempDir();
    const cases: [string, number[]][] = [
      ['mysqldump  Ver 26.10.0 for macos26.6 on arm64 (Homebrew)', [26, 10, 0]],
      ['mysqldump  Ver 10.19 Distrib 10.11.6-MariaDB, for osx10.20 (arm64)', [10, 11, 6]],
      ['pg_dump (PostgreSQL) 18.6 (Homebrew)', [18, 6]],
    ];
    for (const [i, [line, expected]] of cases.entries()) {
      const tool = fakeTool(path.join(root, String(i)), 'mysqldump', line);
      expect(dumpToolVersion(tool)).toEqual(expected);
    }
  });

  it('round-trips pinned tools and the dump folder in the managed file', () => {
    const root = tempDir();
    const file = path.join(root, 'overrides.json');
    saveManagedSettings({ tools: { pgDump: '/opt/pg/bin/pg_dump' }, dumpDirectory: root }, file);
    expect(loadManagedSettings(file)).toEqual({
      tools: { pgDump: '/opt/pg/bin/pg_dump' },
      dumpDirectory: root,
    });
    expect(() => saveManagedSettings({ tools: { pgDump: 'relative/pg_dump' } }, file)).toThrow();
    expect(loadManagedSettings(file).tools?.pgDump).toBe('/opt/pg/bin/pg_dump');
  });

  it('uses the pinned client and folder from the managed file', () => {
    const root = tempDir();
    const pinned = fakeTool(path.join(root, 'pinned'), 'pg_dump', 'pg_dump (PostgreSQL) 16.0');
    const file = path.join(root, 'overrides.json');
    setEnv('HOPSQL_OVERRIDES_FILE', file);
    setEnv('HOPSQL_PG_DUMP_PATH', undefined);
    setEnv('HOPSQL_DUMP_DIR', undefined);
    saveManagedSettings({ tools: { pgDump: pinned }, dumpDirectory: path.join(root, 'out') });
    expect(resolveDumpBinary('postgres').path).toBe(pinned);
    expect(dumpDirectory()).toBe(path.join(root, 'out'));
  });
});

describe('dump files', () => {
  it('creates a new private file inside the dump folder only', async () => {
    const root = tempDir();
    const { path: file, handle } = await createDumpFile('orders.sql', path.join(root, 'dumps'));
    await handle.close();
    expect(path.dirname(file)).toBe(path.join(root, 'dumps'));
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    for (const bad of ['../escape.sql', 'a/b.sql', '.hidden', '', 'x'.repeat(300)])
      await expect(createDumpFile(bad, root)).rejects.toBeInstanceOf(DumpError);
    // Never replaces an existing dump.
    await expect(createDumpFile('orders.sql', path.join(root, 'dumps'))).rejects.toMatchObject({
      code: 'DUMP_INVALID_OPTIONS',
    });
  });
});
