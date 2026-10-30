import { afterEach, describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  DumpError,
  buildDumpCommand,
  dumpFlavorFor,
  resolveDumpBinary,
  resolveDumpTarget,
  runDump,
} from '../src/runtime/dump.js';
import type { DatabaseConnection, DumpCommand, DumpTarget } from '../src/types.js';

const fixture = path.join(import.meta.dir, 'fixtures', 'fake-dump.mjs');
const dirs: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'hopsql-dump-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const pg = { path: '/opt/pg/bin/pg_dump', flavor: 'postgres' as const };
const mysql = { path: '/opt/mysql/bin/mysqldump', flavor: 'mysql' as const };
const mariadb = { path: '/opt/mariadb/bin/mariadb-dump', flavor: 'mariadb' as const };
const secret = 'fixture-secret-"pw"\\x';
const target: DumpTarget = {
  host: 'db.fixture.test',
  port: 5432,
  tunneled: false,
  database: 'app',
  user: 'reader',
  password: secret,
};

function sink() {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { out, text: () => Buffer.concat(chunks).toString('utf8') };
}
/** Launch the node fixture in place of the dump client. */
function viaFixture(command: DumpCommand, mode = 'echo', extra: Record<string, string> = {}) {
  return {
    ...command,
    command: process.execPath,
    prefixArgs: [fixture],
    env: { ...command.env, FAKE_DUMP_MODE: mode, ...extra },
  };
}
async function dumpError(work: Promise<unknown>): Promise<DumpError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(DumpError);
    return error as DumpError;
  }
  throw new Error('expected a DumpError');
}

describe('dump command construction', () => {
  it('maps drivers to dump clients', () => {
    expect(dumpFlavorFor('postgresql')).toBe('postgres');
    expect(dumpFlavorFor('mysql')).toBe('mysql');
    expect(dumpFlavorFor('mariadb')).toBe('mariadb');
    expect(dumpFlavorFor('sqlite')).toBeNull();
  });

  it('keeps the PostgreSQL password and database out of argv', () => {
    const command = buildDumpCommand(pg, target, { tables: ['public.Orders'], schemaOnly: true });
    expect(command.args.join(' ')).not.toContain(secret);
    expect(command.args).toContain('--no-password');
    expect(command.args).toContain('--schema-only');
    expect(command.args).not.toContain('--data-only');
    expect(command.args).toContain('--table="public"."Orders"');
    expect(command.env.PGPASSWORD).toBe(secret);
    expect(command.env.PGDATABASE).toBe('app');
    expect(command.defaultsFile).toBeUndefined();
  });

  it('dials the tunnel endpoint and keeps the TLS name for verify-full', () => {
    const tunneled = { ...target, host: '127.0.0.1', port: 40123, tunneled: true };
    const plain = buildDumpCommand(pg, tunneled, { dataOnly: true });
    expect(plain.args).toContain('--host=127.0.0.1');
    expect(plain.args).toContain('--port=40123');
    expect(plain.args).toContain('--data-only');
    const verified = buildDumpCommand(
      pg,
      { ...tunneled, serverName: 'db.fixture.test', ssl: { mode: 'verify-full', ca: '/ca.pem' } },
      {}
    );
    expect(verified.args).toContain('--host=db.fixture.test');
    expect(verified.env.PGHOSTADDR).toBe('127.0.0.1');
    expect(verified.env.PGSSLMODE).toBe('verify-full');
    expect(verified.env.PGSSLROOTCERT).toBe('/ca.pem');
  });

  it('puts MySQL credentials in a private option file and maps flags', () => {
    const command = buildDumpCommand(
      mysql,
      { ...target, port: 3306, ssl: { mode: 'VERIFY_CA', ca: '/ca.pem' } },
      { tables: ['app.orders', 'items'], schemaOnly: true }
    );
    expect(command.args.join(' ')).not.toContain(secret);
    expect(command.defaultsFile).toContain('password=');
    expect(command.args).toEqual(
      expect.arrayContaining([
        '--protocol=TCP',
        '--no-data',
        '--ssl-mode=VERIFY_CA',
        '--ssl-ca=/ca.pem',
      ])
    );
    expect(command.args.slice(-3)).toEqual(['app', 'orders', 'items']);
    const data = buildDumpCommand(mysql, target, { dataOnly: true });
    expect(data.args).toContain('--no-create-info');
  });

  it('uses MariaDB TLS flags and MYSQL_PWD on Windows', () => {
    const command = buildDumpCommand(
      mariadb,
      { ...target, ssl: { mode: 'VERIFY_IDENTITY' } },
      {},
      {},
      'win32'
    );
    expect(command.args).toEqual(
      expect.arrayContaining(['--no-defaults', '--ssl', '--ssl-verify-server-cert'])
    );
    expect(command.args.some((arg) => arg.startsWith('--ssl-mode'))).toBe(false);
    expect(command.env.MYSQL_PWD).toBe(secret);
    expect(command.defaultsFile).toBeUndefined();
  });

  it('keeps the CA check but not the hostname check for MySQL TLS through a tunnel', () => {
    const tunneled = { ...target, host: '127.0.0.1', port: 40123, tunneled: true };
    const ssl = { mode: 'VERIFY_IDENTITY', ca: '/ca.pem' };
    const direct = buildDumpCommand(mysql, { ...target, ssl }, {});
    expect(direct.args).toContain('--ssl-mode=VERIFY_IDENTITY');
    expect(direct.tlsHostnameVerified).toBeUndefined();

    const viaTunnel = buildDumpCommand(mysql, { ...tunneled, ssl }, {});
    expect(viaTunnel.args).toEqual(
      expect.arrayContaining(['--ssl-mode=VERIFY_CA', '--ssl-ca=/ca.pem'])
    );
    expect(viaTunnel.args).not.toContain('--ssl-mode=VERIFY_IDENTITY');
    expect(viaTunnel.tlsHostnameVerified).toBe(false);

    const maria = buildDumpCommand(mariadb, { ...tunneled, ssl }, {});
    expect(maria.args).toEqual(expect.arrayContaining(['--ssl', '--ssl-ca=/ca.pem']));
    expect(maria.args).not.toContain('--ssl-verify-server-cert');
    expect(maria.tlsHostnameVerified).toBe(false);

    const required = buildDumpCommand(mysql, { ...tunneled, ssl: { mode: 'REQUIRED' } }, {});
    expect(required.args).toContain('--ssl-mode=REQUIRED');
    expect(required.tlsHostnameVerified).toBeUndefined();
  });

  it('stops MySQL clients from reading ~/.mylogin.cnf', () => {
    expect(buildDumpCommand(mysql, target, {}).env.MYSQL_TEST_LOGIN_FILE).toBe(devNull);
    expect(buildDumpCommand(mariadb, target, {}, {}, 'win32').env.MYSQL_TEST_LOGIN_FILE).toBe(
      devNull
    );
    expect(buildDumpCommand(pg, target, {}).env.MYSQL_TEST_LOGIN_FILE).toBeUndefined();
  });

  it('rejects conflicting or unsafe options with a structured code', () => {
    for (const work of [
      () => buildDumpCommand(pg, target, { schemaOnly: true, dataOnly: true }),
      () => buildDumpCommand(mysql, { ...target, database: '--all-databases' }, {}),
      () => buildDumpCommand(mysql, target, { tables: ['other.orders'] }),
      () => buildDumpCommand(mysql, { ...target, database: undefined }, {}),
    ]) {
      try {
        work();
        throw new Error('expected failure');
      } catch (error) {
        expect((error as DumpError).code).toBe('DUMP_INVALID_OPTIONS');
      }
    }
  });

  it('resolves the tunnel endpoint and connection credentials', async () => {
    const connection: DatabaseConnection = {
      id: 'fixture',
      name: 'fixture',
      driver: 'postgresql',
      url: '',
      host: 'localhost',
      port: 5432,
      database: 'app',
      user: 'reader',
      properties: { password: secret, sslmode: 'require' },
    };
    const resolved = await resolveDumpTarget(connection, 'postgres', {
      env: {},
      resolveEndpoint: async () => ({ host: '127.0.0.1', port: 40999 }),
    });
    expect(resolved).toMatchObject({
      host: '127.0.0.1',
      port: 40999,
      tunneled: true,
      user: 'reader',
      password: secret,
      ssl: { mode: 'require' },
    });
    const direct = await resolveDumpTarget(connection, 'postgres', {
      env: {},
      resolveEndpoint: async () => null,
    });
    expect(direct).toMatchObject({ host: 'localhost', port: 5432, tunneled: false });
  });
});

describe('dump binary resolution', () => {
  it('reports a missing client with a stable code and install hint', async () => {
    const empty = tempDir();
    const error = await dumpError(
      Promise.resolve().then(() => resolveDumpBinary('postgres', { PATH: empty }))
    );
    expect(error.code).toBe('DUMP_TOOL_MISSING');
    expect(error.details).toMatchObject({ envVar: 'HOPSQL_PG_DUMP_PATH' });
    expect(typeof error.details.install).toBe('string');
    const override = await dumpError(
      Promise.resolve().then(() =>
        resolveDumpBinary('mysql', { PATH: empty, HOPSQL_MYSQLDUMP_PATH: path.join(empty, 'x') })
      )
    );
    expect(override.code).toBe('DUMP_TOOL_MISSING');
  });

  it('prefers mariadb-dump for MariaDB and honours the path override', () => {
    const dir = tempDir();
    const ext = process.platform === 'win32' ? '.exe' : '';
    for (const name of ['mariadb-dump', 'mysqldump']) {
      fs.writeFileSync(path.join(dir, name + ext), '');
      fs.chmodSync(path.join(dir, name + ext), 0o755);
    }
    const found = resolveDumpBinary('mariadb', { PATH: dir });
    expect(path.basename(found.path)).toBe('mariadb-dump' + ext);
    expect(found.flavor).toBe('mariadb');
    expect(resolveDumpBinary('mysql', { PATH: dir }).flavor).toBe('mysql');
    const override = path.join(dir, 'mysqldump' + ext);
    expect(resolveDumpBinary('mariadb', { HOPSQL_MYSQLDUMP_PATH: override }).path).toBe(override);
  });
});

describe('dump execution', () => {
  it('streams stdout and removes the private option file', async () => {
    const command = buildDumpCommand(mysql, target, { tables: ['orders'] });
    const output = sink();
    const result = await runDump(viaFixture(command), {
      timeoutMs: 10000,
      maxBytes: 1024 * 1024,
      sink: output.out,
    });
    const echoed = JSON.parse(output.text());
    expect(result.bytes).toBe(Buffer.byteLength(output.text()));
    expect(echoed.args.join(' ')).not.toContain(secret);
    expect(echoed.args[0]).toMatch(/^--defaults-file=/);
    expect(echoed.defaults).toContain('password=');
    expect(fs.existsSync(echoed.defaultsPath)).toBe(false);
  });

  it('kills the child on timeout', async () => {
    const pidFile = path.join(tempDir(), 'pid');
    const command = buildDumpCommand(pg, target, {});
    const error = await dumpError(
      runDump(viaFixture(command, 'sleep', { FAKE_DUMP_PID_FILE: pidFile }), {
        timeoutMs: 1500,
        maxBytes: 1024,
        sink: sink().out,
      })
    );
    expect(error.code).toBe('DUMP_TIMEOUT');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('stops at the byte cap', async () => {
    const error = await dumpError(
      runDump(viaFixture(buildDumpCommand(pg, target, {}), 'flood'), {
        timeoutMs: 10000,
        maxBytes: 200 * 1024,
        sink: sink().out,
      })
    );
    expect(error.code).toBe('DUMP_OUTPUT_LIMIT');
  });

  it('refuses quoted arguments for a Windows .cmd dump client before running it', async () => {
    const command = buildDumpCommand(
      { path: 'C:\\pg\\bin\\pg_dump.cmd', flavor: 'postgres' },
      target,
      { tables: ['public.orders'] },
      {},
      'win32'
    );
    const error = await dumpError(
      runDump(command, { timeoutMs: 10000, maxBytes: 1024, sink: sink().out, platform: 'win32' })
    );
    expect(error.code).toBe('DUMP_INVALID_OPTIONS');
  });

  it('reports client failures and missing executables', async () => {
    const failed = await dumpError(
      runDump(viaFixture(buildDumpCommand(pg, target, {}), 'fail'), {
        timeoutMs: 10000,
        maxBytes: 1024,
        sink: sink().out,
      })
    );
    expect(failed.code).toBe('DUMP_FAILED');
    expect(failed.details.exitCode).toBe(3);
    const missing = await dumpError(
      runDump(
        { command: path.join(tempDir(), 'absent'), args: [], env: {} },
        { timeoutMs: 10000, maxBytes: 1024, sink: sink().out }
      )
    );
    expect(missing.code).toBe('DUMP_TOOL_MISSING');
  });
});
