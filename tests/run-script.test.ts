import { afterEach, describe, expect, it, vi, mock } from 'bun:test';
import { TransactionManager, ScriptStatementError } from '../src/managers/transaction-manager.js';
import { splitSqlScript, validateStatement } from '../src/policy/sql.js';
import { AccessPolicy } from '../src/policy/access.js';
import {
  describeScriptForApproval,
  scriptDdlError,
  scriptStatements,
} from '../src/runtime/script.js';
import type { DatabaseConnection } from '../src/types.js';
import type { ConnectionPoolManager } from '../src/pools/connection-pool.js';
import { readPostgres } from '../src/runtime/sql-sessions.js';
mock.module('../src/runtime/sql-sessions.js', () => ({
  readPostgres: vi.fn(),
  readMysql: vi.fn(),
  readSqlServer: vi.fn(),
}));

const connection: DatabaseConnection = {
  url: '',
  id: 'fixture',
  name: 'fixture',
  driver: 'postgres',
  host: 'localhost',
  database: 'fixture',
  readonly: false,
};

function setup(type: 'postgres' | 'mysql' = 'postgres') {
  const client = {
    query: vi.fn().mockResolvedValue({}),
    release: vi.fn(),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    getConnection: vi.fn().mockResolvedValue(client),
  };
  const manager = new TransactionManager({
    getPool: vi.fn().mockResolvedValue({ pool, type }),
  } as unknown as ConnectionPoolManager);
  return { manager, client };
}

afterEach(() => {
  vi.restoreAllMocks();
  (readPostgres as ReturnType<typeof vi.fn>).mockReset();
});

const DO_BLOCK = `DO $$ BEGIN UPDATE t SET a = 1 WHERE id = 1; END $$`;

describe('splitSqlScript', () => {
  it('splits at top-level semicolons only', () => {
    expect(
      splitSqlScript(`
        -- header; not a statement
        UPDATE t SET a = 'x;y' WHERE id = 1;
        /* block; comment */
        ${DO_BLOCK};
        INSERT INTO "we;ird" VALUES (1)
      `)
    ).toEqual([
      `-- header; not a statement\n        UPDATE t SET a = 'x;y' WHERE id = 1`,
      `/* block; comment */\n        ${DO_BLOCK}`,
      'INSERT INTO "we;ird" VALUES (1)',
    ]);
  });

  it('keeps tagged dollar bodies whole and drops comment-only tails', () => {
    expect(splitSqlScript('DO $fn$ BEGIN PERFORM 1; END $fn$; -- done')).toHaveLength(1);
    expect(() => splitSqlScript("UPDATE t SET a = 'open")).toThrow();
    expect(() => splitSqlScript('-- only a comment')).toThrow();
  });
});

describe('scriptStatements', () => {
  it('drops a wrapping BEGIN/COMMIT, which the tool provides', () => {
    expect(scriptStatements('BEGIN; UPDATE t SET a=1 WHERE id=1; COMMIT;')).toEqual([
      'UPDATE t SET a=1 WHERE id=1',
    ]);
    expect(scriptStatements('START TRANSACTION; DELETE FROM t WHERE id=2; END')).toEqual([
      'DELETE FROM t WHERE id=2',
    ]);
  });

  it('keeps transaction control anywhere else, so validation refuses it', () => {
    expect(scriptStatements('UPDATE t SET a=1 WHERE id=1; ROLLBACK')).toHaveLength(2);
    expect(validateStatement('ROLLBACK')).not.toBeNull();
  });
});

describe('DO blocks', () => {
  it('are accepted as statements', () => {
    expect(validateStatement(DO_BLOCK)).toBeNull();
    expect(validateStatement(DO_BLOCK, ['insert', 'do'])).toBeNull();
  });

  it('are refused when the connection has access policy scoping', () => {
    const policy = new AccessPolicy();
    expect(() => policy.assertQuery(connection, DO_BLOCK, false)).not.toThrow();
    expect(() =>
      policy.assertQuery({ ...connection, id: 'fixture/other' }, DO_BLOCK, false)
    ).toThrow();
  });
});

describe('describeScriptForApproval', () => {
  it('shows short scripts in full with counts and a hash', () => {
    const text = 'UPDATE t SET a=1 WHERE id=1; INSERT INTO t VALUES (2)';
    const shown = describeScriptForApproval(scriptStatements(text), text, '/m.sql')!;
    expect(shown).toContain('UPDATE t SET a=1 WHERE id=1');
    expect(shown).toContain('INSERT INTO t VALUES (2)');
    expect(shown).toContain('/m.sql');
  });

  it('never shortens: a script too long to show in full is not described', () => {
    const statements = Array.from(
      { length: 100 },
      (_, i) => `UPDATE t SET a = '${'x'.repeat(200)}' WHERE id = ${i}`
    );
    expect(describeScriptForApproval(statements, statements.join(';'))).toBeNull();
  });

  it('keeps line breaks, so a line comment cannot hide the next line', () => {
    const statement = 'DELETE FROM t WHERE id = 1 --\nOR true';
    const shown = describeScriptForApproval([statement], statement)!;
    expect(shown).toContain('\n   OR true');
  });
});

describe('scriptDdlError', () => {
  it('allows schema objects and refuses code and security objects', () => {
    for (const ok of [
      'CREATE TABLE IF NOT EXISTS x (id int)',
      'CREATE UNIQUE INDEX i ON x (id)',
      'CREATE OR REPLACE VIEW v AS SELECT 1',
      'CREATE MATERIALIZED VIEW m AS SELECT 1',
      'ALTER TABLE x ADD COLUMN y int',
      'DROP SEQUENCE IF EXISTS s',
      'UPDATE x SET y = 1 WHERE id = 1',
    ])
      expect(scriptDdlError(ok)).toBeNull();
    for (const refused of [
      'CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$',
      'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql',
      'CREATE TRIGGER tr AFTER INSERT ON x FOR EACH ROW EXECUTE FUNCTION f()',
      'CREATE ROLE admin LOGIN SUPERUSER',
      'CREATE EXTENSION dblink',
      'ALTER ROLE admin SUPERUSER',
      'CREATE RULE r AS ON INSERT TO x DO INSTEAD NOTHING',
    ])
      expect(scriptDdlError(refused)).not.toBeNull();
    expect(() =>
      scriptStatements('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql')
    ).toThrow();
  });
});

describe('TransactionManager.runScript', () => {
  it('runs every statement in one transaction and commits', async () => {
    const { manager, client } = setup();
    readPostgres.mockResolvedValue({ columns: [], rows: [], rowCount: 0, affectedRows: 2 });
    const results = await manager.runScript(connection, [
      'UPDATE t SET a = 1 WHERE id = 1',
      DO_BLOCK,
      'CREATE TABLE x (id int)',
    ]);
    expect(results.map((r) => r.operation)).toEqual(['update', 'do', 'create']);
    expect(results[0].affectedRows).toBe(2);
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'COMMIT']);
    expect(manager.getActiveTransactions()).toEqual([]);
  });

  it('rolls everything back at the first failing statement', async () => {
    const { manager, client } = setup();
    readPostgres
      .mockResolvedValueOnce({ columns: [], rows: [], rowCount: 0, affectedRows: 1 })
      .mockRejectedValueOnce(new Error('duplicate key'));
    const run = manager.runScript(connection, [
      'UPDATE t SET a = 1 WHERE id = 1',
      'INSERT INTO t VALUES (1)',
      'DELETE FROM t WHERE id = 3',
    ]);
    await expect(run).rejects.toBeInstanceOf(ScriptStatementError);
    await run.catch((error: ScriptStatementError) => expect(error.statement).toBe(2));
    expect(readPostgres).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls.map((c) => c[0])).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledWith(true);
    expect(manager.getActiveTransactions()).toEqual([]);
  });

  it('refuses code objects mid-script and rolls back what ran', async () => {
    const { manager, client } = setup();
    readPostgres.mockResolvedValue({ columns: [], rows: [], rowCount: 1 });
    await expect(
      manager.runScript(connection, [
        'UPDATE t SET a = 1 WHERE id = 1',
        'CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()',
      ])
    ).rejects.toBeInstanceOf(ScriptStatementError);
    expect(readPostgres).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('refuses DDL on MySQL, which would commit implicitly', async () => {
    const { manager, client } = setup('mysql');
    await expect(manager.runScript(connection, ['CREATE TABLE x (id int)'])).rejects.toBeInstanceOf(
      ScriptStatementError
    );
    expect(client.commit).not.toHaveBeenCalled();
  });

  it('refuses a read-only connection before starting', async () => {
    const { manager, client } = setup();
    await expect(
      manager.runScript({ ...connection, readonly: true }, ['UPDATE t SET a=1 WHERE id=1'])
    ).rejects.toThrow();
    expect(client.query).not.toHaveBeenCalled();
  });
});
