/** Preparing a multi-statement script for `run_script`. */

import { createHash } from 'node:crypto';
import { splitSqlScript, sqlTokens } from '../policy/sql.js';

const OPEN = /^(?:begin|start\s+transaction)(?:\s+(?:transaction|work|tran))?$/i;
const CLOSE = /^(?:commit|end)(?:\s+(?:transaction|work|tran))?$/i;
/** The most an approval prompt shows; longer scripts are split, never cut. */
export const MAX_APPROVAL_CHARS = 16000;

/**
 * Schema objects a script may create, alter or drop. Code and security
 * objects (functions, triggers, rules, roles, extensions, ...) run or grant
 * things the access checks cannot see, so they are refused.
 */
const DDL_OBJECTS = new Set(['table', 'index', 'view', 'sequence', 'type']);
const DDL_MODIFIERS = new Set([
  'or',
  'replace',
  'unique',
  'temp',
  'temporary',
  'unlogged',
  'materialized',
  'if',
  'not',
  'exists',
  'global',
  'local',
]);

/** Why a DDL statement may not run in a script, or null when it may. */
export function scriptDdlError(statement: string): string | null {
  const words = sqlTokens(statement)
    .filter((t) => t.kind === 'word')
    .map((t) => t.value);
  if (!['create', 'alter', 'drop'].includes(words[0])) return null;
  const object = words.slice(1).find((word) => !DDL_MODIFIERS.has(word));
  if (object && DDL_OBJECTS.has(object)) return null;
  return `Scripts can only create, alter or drop tables, indexes, views, sequences and types, not ${object ?? 'this object'}`;
}

/**
 * The statements to run. A leading BEGIN and trailing COMMIT are dropped,
 * since the script already runs in one transaction; any other transaction
 * control fails validation, as in execute_in_transaction.
 */
export function scriptStatements(script: string): string[] {
  const statements = splitSqlScript(script);
  if (statements.length > 1 && OPEN.test(statements[0])) statements.shift();
  if (statements.length > 1 && CLOSE.test(statements[statements.length - 1])) statements.pop();
  if (statements.length > 500) throw new Error('Scripts can have at most 500 statements');
  for (const statement of statements) {
    const error = scriptDdlError(statement);
    if (error) throw new Error(error);
  }
  return statements;
}

/**
 * What the user approves: every statement in full. Line breaks are kept so a
 * `--` comment cannot appear to swallow code that follows it on the next line;
 * only runs of spaces and blank lines are collapsed. Null when it is too long
 * to show, in which case the script must be split rather than shortened.
 */
export function describeScriptForApproval(
  statements: string[],
  text: string,
  file?: string
): string | null {
  const counts = new Map<string, number>();
  for (const statement of statements) {
    const operation = sqlTokens(statement)[0]?.value.toUpperCase() ?? '?';
    counts.set(operation, (counts.get(operation) ?? 0) + 1);
  }
  const header = [
    `${statements.length} statements in one transaction: ${[...counts].map(([op, n]) => `${n} ${op}`).join(', ')}`,
    ...(file ? [`File: ${file}`] : []),
    `SHA-256: ${createHash('sha256').update(text).digest('hex').slice(0, 16)}`,
  ].join('\n');
  const tidy = (sql: string) =>
    sql
      .split('\n')
      .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n   ');
  const body = statements.map((s, i) => `${i + 1}. ${tidy(s)}`).join('\n');
  const shown = `${header}\n\n${body}`;
  return shown.length > MAX_APPROVAL_CHARS ? null : shown;
}
