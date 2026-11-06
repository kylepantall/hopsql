/** Preparing a multi-statement script for `run_script`. */

import { createHash } from 'node:crypto';
import { splitSqlScript } from '../policy/sql.js';

const OPEN = /^(?:begin|start\s+transaction)(?:\s+(?:transaction|work|tran))?$/i;
const CLOSE = /^(?:commit|end)(?:\s+(?:transaction|work|tran))?$/i;
const SHOW_IN_FULL = 4000;
const SUMMARY_LINE = 120;

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
  return statements;
}

/**
 * What the user approves. A short script is shown in full. A longer one shows
 * one line per statement, plus the file and a hash of the exact text that
 * will run, so it can be checked against the file before approving.
 */
export function describeScriptForApproval(
  statements: string[],
  text: string,
  file?: string
): string {
  const counts = new Map<string, number>();
  for (const statement of statements) {
    const operation = statement.match(/^\s*([a-z]+)/i)?.[1].toUpperCase() ?? '?';
    counts.set(operation, (counts.get(operation) ?? 0) + 1);
  }
  const header = [
    `${statements.length} statements in one transaction: ${[...counts].map(([op, n]) => `${n} ${op}`).join(', ')}`,
    ...(file ? [`File: ${file}`] : []),
    `SHA-256: ${createHash('sha256').update(text).digest('hex').slice(0, 16)}`,
  ].join('\n');
  const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  const full = statements.map((s, i) => `${i + 1}. ${collapse(s)}`).join('\n');
  if (full.length <= SHOW_IN_FULL) return `${header}\n\n${full}`;
  const lines = statements.map((s, i) => {
    const line = collapse(s);
    return `${i + 1}. ${line.length > SUMMARY_LINE ? `${line.slice(0, SUMMARY_LINE)}…` : line}`;
  });
  return `${header}\n\n${lines.join('\n')}\n\nStatements are shortened; review the full script${file ? ' in the file' : ''} before approving.`;
}
