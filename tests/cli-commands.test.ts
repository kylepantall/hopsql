import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MAX_SQL_FILE_BYTES, readSqlFile, resolveQueryText } from '../src/utils.js';
import { connectionEnv, createRedactor, parseExecArgs } from '../src/exec.js';
import { parseQueryArgs } from '../src/query-cli.js';

const directory = mkdtempSync(join(tmpdir(), 'hopsql-sql-file-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const file = (name: string, contents: string | Buffer) => {
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
};

describe('SQL files', () => {
  it('reads SQL files, absolute or relative to the working directory', () => {
    const path = file('report.sql', 'SELECT 1');
    expect(readSqlFile(path)).toBe('SELECT 1');
    expect(readSqlFile('report.sql', directory)).toBe('SELECT 1');
    expect(readSqlFile(file('UPPER.PGSQL', 'SELECT 2'))).toBe('SELECT 2');
  });

  it('refuses non-SQL files, including through a symlink named .sql', () => {
    const secret = file('id_rsa', 'PRIVATE KEY');
    expect(() => readSqlFile(secret)).toThrow();
    const link = join(directory, 'innocent.sql');
    symlinkSync(secret, link);
    expect(() => readSqlFile(link)).toThrow();
  });

  it('refuses directories, missing files and oversized files', () => {
    expect(() => readSqlFile(join(directory, 'missing.sql'))).toThrow();
    expect(() => readSqlFile(file('big.sql', Buffer.alloc(MAX_SQL_FILE_BYTES + 1, 32)))).toThrow();
  });

  it('takes exactly one of query or file', () => {
    expect(resolveQueryText({ query: 'SELECT 3' })).toBe('SELECT 3');
    expect(resolveQueryText({ file: file('three.sql', 'SELECT 3') })).toBe('SELECT 3');
    expect(() => resolveQueryText({})).toThrow();
    expect(() => resolveQueryText({ query: 'SELECT 3', file: 'three.sql' })).toThrow();
  });
});

describe('hopsql query arguments', () => {
  it('maps inline SQL and files onto execute_query / write_query', () => {
    expect(parseQueryArgs(['db', 'SELECT', '1', '--max-rows', '5'])).toEqual({
      tool: 'execute_query',
      args: { connectionId: 'db', query: 'SELECT 1', maxRows: 5 },
    });
    expect(parseQueryArgs(['db', '--file', 'q.sql', '--write', '--database', 'other'])).toEqual({
      tool: 'write_query',
      args: { connectionId: 'db', file: 'q.sql', database: 'other' },
    });
  });

  it('rejects ambiguous or incomplete invocations', () => {
    for (const argv of [
      [],
      ['db'],
      ['db', 'SELECT 1', '--file', 'q.sql'],
      ['db', '--file'],
      ['db', 'SELECT 1', '--max-rows', '0'],
      ['db', 'SELECT 1', '--unknown'],
    ])
      expect(() => parseQueryArgs(argv)).toThrow();
  });
});

describe('hopsql exec', () => {
  it('parses the connection, database and command after --', () => {
    expect(parseExecArgs(['db', '--database', 'app', '--', 'psql', '-c', 'select 1'])).toEqual({
      connectionId: 'db',
      database: 'app',
      command: 'psql',
      args: ['-c', 'select 1'],
    });
    expect(() => parseExecArgs(['db', 'psql'])).toThrow();
    expect(() => parseExecArgs(['db', '--'])).toThrow();
  });

  it('builds libpq variables and a URL-encoded DATABASE_URL for PostgreSQL', () => {
    const env = connectionEnv(
      {
        host: '127.0.0.1',
        port: 6543,
        tunneled: true,
        serverName: 'db.internal',
        database: 'app',
        user: 'svc',
        password: 'p@ss/w:rd',
        ssl: { mode: 'verify-full', ca: '/ca.pem' },
      },
      'postgres'
    );
    expect(env).toMatchObject({
      PGHOST: 'db.internal',
      PGHOSTADDR: '127.0.0.1',
      PGPORT: '6543',
      PGUSER: 'svc',
      PGPASSWORD: 'p@ss/w:rd',
      PGDATABASE: 'app',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/ca.pem',
    });
    const url = new URL(env.DATABASE_URL);
    expect(decodeURIComponent(url.password)).toBe('p@ss/w:rd');
    expect(url.port).toBe('6543');
    expect(url.searchParams.get('hostaddr')).toBe('127.0.0.1');
  });

  it('builds MySQL client variables and DATABASE_URL', () => {
    const env = connectionEnv(
      { host: 'localhost', port: 3306, tunneled: false, database: 'shop', user: 'root' },
      'mariadb'
    );
    expect(env).toEqual({
      MYSQL_HOST: 'localhost',
      MYSQL_TCP_PORT: '3306',
      MYSQL_USER: 'root',
      MYSQL_DATABASE: 'shop',
      DATABASE_URL: 'mariadb://root@localhost:3306/shop',
    });
  });

  it('masks secrets in piped output, even when split across chunks', async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk) => chunks.push(chunk));
    const redactor = createRedactor(['hunter22', 'x'], sink);
    for (const part of ['password=hun', 'ter22 and ', 'again hunter22', ' x done'])
      redactor.write(Buffer.from(part));
    redactor.end();
    sink.end();
    await new Promise((resolve) => sink.on('end', resolve));
    const output = Buffer.concat(chunks).toString();
    expect(output).not.toContain('hunter22');
    // Secrets shorter than four characters are not masked, so ordinary text survives.
    expect(output).toContain(' x done');
  });
});
