// End-to-end access modes against a real server: `hopsql access` changes apply to
// a running server without a restart, `ask` needs the client's approval for each
// write, SQL files run through the tools, and `hopsql exec` masks credentials.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

const entry = resolve('dist/index.js');
const directory = mkdtempSync(join(tmpdir(), 'hopsql-access-'));
const database = join(directory, 'demo.db');
const password = 'canary-exec-password-7f3a';
const env = {
  ...process.env,
  HOPSQL_CONFIG_FILE: join(directory, 'connections.json'),
  HOPSQL_OVERRIDES_FILE: join(directory, 'overrides.json'),
  HOPSQL_DISCOVER_WORKSPACE: 'false',
  HOPSQL_UPDATE_NOTIFIER: 'false',
  // The ceiling a default install registers; managed access must outrank it.
  HOPSQL_READ_ONLY: 'true',
  HOPSQL_EXEC_FIXTURE_PASSWORD: password,
};
const cli = (...args) =>
  spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 30000 });
const access = (...args) => assert.equal(cli('access', ...args).status, 0);
const rows = () =>
  execFileSync('sqlite3', [database, 'SELECT group_concat(id) FROM t ORDER BY id'], {
    encoding: 'utf8',
  }).trim();
const until = async (check) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
  assert(check(), 'Timed out waiting for the server');
};

async function connect(elicitation) {
  const client = new Client(
    { name: 'access-check', version: '1' },
    { capabilities: elicitation ? { elicitation: {} } : {} }
  );
  const state = { listChanged: 0, prompts: [], answer: 'decline' };
  if (elicitation)
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      state.prompts.push(request.params.message);
      return state.answer === 'approve'
        ? { action: 'accept', content: { approve: true } }
        : { action: 'decline' };
    });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => state.listChanged++);
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: 'ignore' })
  );
  return { client, state };
}

/** Resolves true when the call ran, false when the server refused it. */
async function succeeds(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return result.isError !== true;
  } catch {
    return false;
  }
}

const clients = [];
try {
  execFileSync('sqlite3', [database, 'CREATE TABLE t(id INTEGER); INSERT INTO t VALUES (1);']);
  writeFileSync(
    env.HOPSQL_CONFIG_FILE,
    JSON.stringify({
      version: 1,
      connections: {
        lite: { driver: 'sqlite', database, readOnly: false },
        pg: {
          driver: 'postgresql',
          host: 'exec-fixture.invalid',
          port: 5432,
          database: 'app',
          user: 'svc',
          passwordEnv: 'HOPSQL_EXEC_FIXTURE_PASSWORD',
          readOnly: false,
        },
      },
    }),
    { mode: 0o600 }
  );
  writeFileSync(join(directory, 'count.sql'), 'SELECT count(*) AS n FROM t');
  writeFileSync(join(directory, 'insert.sql'), 'INSERT INTO t VALUES (10)');
  writeFileSync(join(directory, 'notes.txt'), 'SELECT 1');

  const { client, state } = await connect(true);
  clients.push(client);
  const hasWriteTools = async () =>
    (await client.listTools()).tools.some((tool) => tool.name === 'write_query');
  const write = (query) => succeeds(client, 'write_query', { connectionId: 'lite', query });

  // Under the env ceiling, a connection at its default stays read-only.
  assert.equal(await hasWriteTools(), false);
  assert.equal(await write('INSERT INTO t VALUES (2)'), false);

  // writable: applies live and announces the new tools.
  access('writable', 'lite');
  await until(() => state.listChanged >= 1);
  assert.equal(await hasWriteTools(), true);
  assert.equal(await write('INSERT INTO t VALUES (2)'), true);
  assert.equal(rows(), '1,2');

  // SQL files run through the tools; other files are refused.
  const count = await client.callTool({
    name: 'execute_query',
    arguments: { connectionId: 'lite', file: join(directory, 'count.sql') },
  });
  assert.deepEqual(count.structuredContent.rows, [[2]]);
  assert.equal(
    await succeeds(client, 'write_query', {
      connectionId: 'lite',
      file: join(directory, 'insert.sql'),
    }),
    true
  );
  assert.equal(
    await succeeds(client, 'execute_query', {
      connectionId: 'lite',
      file: join(directory, 'notes.txt'),
    }),
    false
  );
  assert.equal(
    await succeeds(client, 'execute_query', {
      connectionId: 'lite',
      query: 'SELECT 1',
      file: join(directory, 'count.sql'),
    }),
    false
  );
  assert.equal(rows(), '1,2,10');

  // ask: every write is approved once, in the client, with the full SQL shown.
  access('ask', 'lite');
  state.answer = 'decline';
  assert.equal(await write('INSERT INTO t VALUES (3)'), false);
  assert.equal(rows(), '1,2,10');
  state.answer = 'approve';
  const padded = 'INSERT INTO t VALUES (3)' + '\n'.repeat(500) + '-- tail-marker';
  assert.equal(await write(padded), true);
  assert.equal(rows(), '1,2,10,3');
  assert.equal(state.prompts.length, 2);
  assert(state.prompts[1].includes('tail-marker'), 'Padding must not hide the statement');
  // Reads never prompt; statements too long to show are refused without asking.
  assert.equal(
    await succeeds(client, 'execute_query', { connectionId: 'lite', query: 'SELECT 1' }),
    true
  );
  assert.equal(await write('INSERT INTO t VALUES (4) ' + '-'.repeat(4100)), false);
  assert.equal(state.prompts.length, 2);
  // A client that cannot ask is refused.
  const { client: mute } = await connect(false);
  clients.push(mute);
  assert.equal(
    await succeeds(mute, 'write_query', {
      connectionId: 'lite',
      query: 'INSERT INTO t VALUES (5)',
    }),
    false
  );

  // read-only: refused again, and the write tools go away.
  access('read-only', 'lite');
  assert.equal(await write('INSERT INTO t VALUES (6)'), false);
  await until(() => state.listChanged >= 2);
  assert.equal(await hasWriteTools(), false);
  assert.equal(rows(), '1,2,10,3');

  // CLI: hopsql query runs files under the same policy.
  const query = cli('query', 'lite', '--file', join(directory, 'count.sql'));
  assert.equal(query.status, 0);
  assert.deepEqual(JSON.parse(query.stdout).rows, [[4]]);

  // hopsql exec: credentials reach the child; piped output never shows them.
  access('writable', 'pg');
  const print = [
    '-e',
    'console.log([process.env.PGHOST, process.env.PGUSER, process.env.PGPASSWORD, process.env.DATABASE_URL].join(" "))',
  ];
  const exec = cli('exec', 'pg', '--', process.execPath, ...print);
  assert.equal(exec.status, 0);
  assert(exec.stdout.includes('exec-fixture.invalid svc'));
  assert(!exec.stdout.includes(password), 'exec must mask the password in piped output');
  const check = cli(
    'exec',
    'pg',
    '--',
    process.execPath,
    '-e',
    `process.exit(process.env.PGPASSWORD === ${JSON.stringify(password)} ? 7 : 1)`
  );
  assert.equal(check.status, 7, 'exec must inject the real password');
  for (const mode of ['ask', 'read-only']) {
    access(mode, 'pg');
    assert.notEqual(cli('exec', 'pg', '--', process.execPath, '-e', '').status, 0);
  }

  console.log(
    'Access modes: live changes, list_changed, ask approvals, SQL files, query CLI and exec masking passed.'
  );
} finally {
  for (const client of clients) await client.close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
}
