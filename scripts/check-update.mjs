// End-to-end update flow against a local stand-in for GitHub: check_for_update
// finds the release, update_hopsql installs it only after the user approves in
// the client, and installs the installer does not own are refused.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const directory = mkdtempSync(join(tmpdir(), 'hopsql-update-check-'));
const install = join(directory, 'install');
const marker = join(directory, 'installer-ran');
const repo = 'kylepantall/hopsql';
const tag = 'v99.0.0';

// An installer-managed layout: <install>/app/dist/index.js.
const app = join(install, 'app');
mkdirSync(app, { recursive: true });
cpSync(resolve('dist'), join(app, 'dist'), { recursive: true });
cpSync(resolve('package.json'), join(app, 'package.json'));
symlinkSync(resolve('node_modules'), join(app, 'node_modules'), 'dir');
const installed = join(app, 'dist', 'index.js');

const requests = [];
const fixture = createServer((request, response) => {
  requests.push(`${request.method} ${request.url}`);
  if (request.url === `/${repo}/releases/latest`) {
    response.writeHead(302, { location: `/${repo}/releases/tag/${tag}` });
  } else if (request.url === `/${repo}/${tag}/scripts/install.sh`) {
    response.writeHead(200);
    // Stands in for the real installer: records the ref and directories it was given.
    response.write(`printf '%s|%s' "$1" "$HOPSQL_INSTALL_DIR" > ${JSON.stringify(marker)}\n`);
  } else response.writeHead(404);
  response.end();
});
await new Promise((ready) => fixture.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${fixture.address().port}`;

const env = {
  ...process.env,
  HOME: join(directory, 'home'),
  HOPSQL_UPDATE_GITHUB_URL: origin,
  HOPSQL_UPDATE_RAW_URL: origin,
  HOPSQL_UPDATE_NOTIFIER: 'false',
  HOPSQL_CONFIG_FILE: join(directory, 'connections.json'),
  HOPSQL_DISCOVER_WORKSPACE: 'false',
};
delete env.HOPSQL_LAUNCHER;
delete env.HOPSQL_SOURCE_DIR;
writeFileSync(
  env.HOPSQL_CONFIG_FILE,
  JSON.stringify({
    version: 1,
    connections: { lite: { driver: 'sqlite', database: join(directory, 'x.db') } },
  }),
  { mode: 0o600 }
);

async function connect(entry, elicitation) {
  const client = new Client(
    { name: 'update-check', version: '1' },
    { capabilities: elicitation ? { elicitation: {} } : {} }
  );
  const state = { prompts: 0, approve: false };
  if (elicitation)
    client.setRequestHandler(ElicitRequestSchema, async () => {
      state.prompts++;
      return state.approve
        ? { action: 'accept', content: { install: true } }
        : { action: 'decline' };
    });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env,
    stderr: 'ignore',
  });
  await client.connect(transport);
  return { client, state, pid: transport.pid };
}
const refused = async (client, name) => {
  try {
    return (await client.callTool({ name, arguments: {} })).isError === true;
  } catch {
    return true;
  }
};
const installerDownloads = () => requests.filter((r) => r.includes('/scripts/')).length;

const clients = [];
try {
  const { client, state } = await connect(installed, true);
  clients.push(client);

  const check = await client.callTool({ name: 'check_for_update', arguments: {} });
  assert.equal(check.structuredContent.updateAvailable, true);
  assert.equal(check.structuredContent.latest.tag, tag);

  // Declining installs nothing and downloads nothing.
  const declined = await client.callTool({ name: 'update_hopsql', arguments: {} });
  assert.equal(declined.structuredContent.updated, false);
  assert.equal(state.prompts, 1);
  assert.equal(installerDownloads(), 0);
  assert.equal(existsSync(marker), false);

  // Approving runs the release's installer against this install directory.
  state.approve = true;
  const approved = await client.callTool({ name: 'update_hopsql', arguments: {} });
  assert.equal(approved.structuredContent.updated, true);
  assert.equal(installerDownloads(), 1);
  assert.deepEqual(readFileSync(marker, 'utf8').split('|'), [tag, realpathSync(install)]);
  rmSync(marker);

  // A client that cannot ask the user is refused before any download.
  const { client: mute, pid: mutePid } = await connect(installed, false);
  clients.push(mute);
  assert.equal(await refused(mute, 'update_hopsql'), true);

  // A checkout (not installer-managed) is refused.
  const { client: checkout } = await connect(resolve('dist/index.js'), true);
  clients.push(checkout);
  assert.equal(await refused(checkout, 'update_hopsql'), true);
  assert.equal(installerDownloads(), 1);
  assert.equal(existsSync(marker), false);

  // CLI: --check reports without installing; --yes installs. Async, so the
  // fixture server in this process can answer.
  const cli = (...args) =>
    new Promise((done) =>
      execFile(
        process.execPath,
        [installed, 'update', ...args],
        { env, encoding: 'utf8', timeout: 30000 },
        (error, stdout, stderr) => done({ status: error ? (error.code ?? 1) : 0, stdout, stderr })
      )
    );
  const status = await cli('--check', '--json');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).updateAvailable, true);
  assert.equal(existsSync(marker), false);
  assert.equal((await cli('--yes')).status, 0);
  assert.equal(readFileSync(marker, 'utf8').split('|')[0], tag);

  // refresh: a newer build lands while servers run. The refresh tool stops the
  // outdated ones and recycles itself; `hopsql refresh` recycles current ones.
  if (process.platform !== 'win32') {
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    await pause(1200);
    utimesSync(installed, new Date(), new Date());
    await pause(1200);
    // An outdated server says it needs a restart rather than claiming to be current.
    const outdated = (await mute.callTool({ name: 'refresh', arguments: {} })).structuredContent;
    assert.equal(outdated.restartRequired, true);
    const { client: current, pid: currentPid } = await connect(installed, false);
    clients.push(current);
    const refreshed = (await current.callTool({ name: 'refresh', arguments: {} }))
      .structuredContent;
    assert.equal(refreshed.restartRequired, false);
    assert.equal(refreshed.recycled, true);
    assert(refreshed.otherServers.stopped.includes(mutePid), 'Outdated servers are stopped');
    for (let i = 0; i < 50 && alive(mutePid); i++) await pause(100);
    assert.equal(alive(mutePid), false);
    const recycledByCli = await new Promise((done) =>
      execFile(process.execPath, [installed, 'refresh'], { env, timeout: 30000 }, (error) =>
        done(error ? 1 : 0)
      )
    );
    assert.equal(recycledByCli, 0);
    assert.equal(alive(currentPid), true, 'Current servers are recycled, not stopped');
    const after = await current.callTool({ name: 'list_connections', arguments: {} });
    assert.notEqual(after.isError, true);
  }

  console.log(
    'Update flow: release check, approval-gated install, refusals, CLI update and refresh passed.'
  );
} finally {
  for (const client of clients) await client.close().catch(() => {});
  fixture.close();
  rmSync(directory, { recursive: true, force: true });
}
