import { afterEach, describe, expect, it, vi, mock } from 'bun:test';
import { TransactionManager, ScriptStatementError } from '../src/managers/transaction-manager.js';
import { splitSqlScript, validateStatement } from '../src/policy/sql.js';
import { AccessPolicy } from '../src/policy/access.js';
import { describeScriptForApproval, scriptStatements } from '../src/runtime/script.js';
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
    const shown = describeScriptForApproval(scriptStatements(text), text, '/m.sql');
    expect(shown).toContain('UPDATE t SET a=1 WHERE id=1');
    expect(shown).toContain('INSERT INTO t VALUES (2)');
    expect(shown).toContain('/m.sql');
  });

  it('shortens each statement of a long script but lists every one', () => {
    const statements = Array.from(
      { length: 40 },
      (_, i) => `UPDATE t SET a = '${'x'.repeat(200)}' WHERE id = ${i}`
    );
    const shown = describeScriptForApproval(statements, statements.join(';'));
    expect(shown.length).toBeLessThan(statements.join(';').length);
    for (let i = 1; i <= 40; i++) expect(shown).toContain(`\n${i}. UPDATE`);
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
