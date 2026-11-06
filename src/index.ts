import './env-compat.js';
import { registerPrivateValue, sanitizeDiagnostic } from './privacy.js';
import fs from 'node:fs';
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  .version as string;
const bunVersion = process.versions.bun;
const current = (bunVersion ?? process.versions.node).split('.').map(Number);
const minimum = [1, 4, 3];
const supported = bunVersion
  ? current[0] > minimum[0] ||
    (current[0] === minimum[0] &&
      (current[1] > minimum[1] || (current[1] === minimum[1] && current[2] >= minimum[2])))
  : current[0] >= 24 || (current[0] === 22 && current[1] >= 15);
if (!supported) {
  console.error(
    `Hopsql ${VERSION} requires Bun 1.4.3+, Node.js 22.15+ LTS, or Node.js 24+. Current: ${bunVersion ? 'Bun' : 'Node.js'} ${bunVersion ?? process.versions.node}`
  );
  process.exit(1);
}
// Handle CLI arguments. MCP clients start the server with piped stdio, so a
// bare `hopsql` typed in a terminal opens the manage UI instead.
const command = process.argv[2];
if (
  command === 'manage' ||
  (command === undefined && process.stdin.isTTY && process.stdout.isTTY)
) {
  try {
    const { runManage } = await import('./manage.js');
    await runManage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}
if (command === 'serve') process.argv.splice(2, 1);

if (process.argv[2] === 'install') {
  try {
    const { runInstall } = await import('./install.js');
    await runInstall(process.argv.slice(3));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}

if (['update', 'query', 'exec', 'access', 'doctor', 'refresh', 'vpn'].includes(process.argv[2])) {
  const args = process.argv.slice(3);
  try {
    if (process.argv[2] === 'vpn') {
      const { runVpnCommand } = await import('./vpn-cli.js');
      const { loadConnections } = await import('./manage.js');
      await runVpnCommand(args, loadConnections);
      process.exit(0);
    }
    if (process.argv[2] === 'refresh') {
      const { runRefresh } = await import('./refresh.js');
      await runRefresh(args);
      process.exit(0);
    }
    if (process.argv[2] === 'doctor') {
      const { runDoctor } = await import('./doctor.js');
      const { loadConnections } = await import('./manage.js');
      process.exit(await runDoctor(args, loadConnections));
    }
    if (process.argv[2] === 'access') {
      const { runAccessCommand } = await import('./manage.js');
      await runAccessCommand(args);
      process.exit(0);
    }
    if (process.argv[2] === 'update') {
      const { runUpdateCommand } = await import('./update.js');
      await runUpdateCommand(args, VERSION);
      process.exit(0);
    }
    const { createServer } = await import('./server.js');
    const server = createServer();
    if (process.argv[2] === 'exec') {
      const { runExec } = await import('./exec.js');
      process.exit(await runExec(args, (id, database) => server.connectionForExec(id, database)));
    }
    const { parseQueryArgs } = await import('./query-cli.js');
    const { tool, args: toolArgs } = parseQueryArgs(args);
    const result = await server.callTool(tool, toolArgs).finally(async () => {
      const { vpnManager } = await import('./net/vpn.js');
      await vpnManager.disconnectAll();
    });
    process.stdout.write(result.content[0].text + '\n');
    process.exit(0);
  } catch (error) {
    console.error(sanitizeDiagnostic(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.error(`
Hopsql MCP Server v${VERSION}

Usage: hopsql                 Manage connections (in a terminal; MCP clients get the server)
       hopsql manage          Turn connections read-only, set up SSM hops and secrets
       hopsql serve [options] Run the MCP server even in a terminal
       hopsql install [claude|codex|opencode] [--config <file> | --workspace <directory>] [--allow <ids>] [--allow-writes] [--dry-run]
       hopsql refresh         Recycle running MCP servers (pools, tunnels, caches); stop ones older than this install
       hopsql doctor [--json] [--strict]
                              Check the command-line tools your connections need (sqlite3, pg_dump, aws, ...)
       hopsql access [<read-only|ask|writable|reset> (<connection>... | --all)]
                              List or bulk-change write access; running servers apply it on the next call
       hopsql query <connection> (<sql> | --file <query.sql>) [--write] [--database <name>] [--max-rows <n>]
       hopsql exec <connection> [--database <name>] -- <command> [args...]
                              Run a tool (psql, mysql, migrations) with the connection's credentials in its env
       hopsql vpn [list | import <file.ovpn> [--name <name>] | use <profile> <connection>... [--docker] | clear <connection>...]
                              Bring a VPN up automatically for connections that need it; --docker keeps it to hopsql
       hopsql update [--check] [--yes] [--json]
                              Install the latest GitHub release

Quick setup:
  curl -fsSL https://raw.githubusercontent.com/kylepantall/hopsql/main/scripts/install.sh | bash -s -- --claude
  hopsql install
  hopsql install claude
  hopsql install codex
  hopsql install opencode

Options:
  -h, --help     Show this help message
  --version      Show version information
  --debug        Enable debug logging

Environment Variables:
  HOPSQL_CONFIG_FILE          JSON file containing database instances and their settings
  HOPSQL_POLICY_FILE          Additional operator access rules
  HOPSQL_DISCOVER_WORKSPACE   Discover saved workspace connections (default: false with a config file; true otherwise)
  HOPSQL_WORKSPACE            Path to local DB client workspace directory
  HOPSQL_PROJECT              Read only this workspace project (default: all projects)
  HOPSQL_TIMEOUT              Query timeout in milliseconds (default: 30000)
  HOPSQL_DEBUG                Enable debug logging (true/false)
  HOPSQL_UPDATE_NOTIFIER      Check GitHub releases for updates at startup (default: true; set false to disable)
  HOPSQL_READ_ONLY            Disable all write operations (default: true; false requires connection write permission)
  HOPSQL_ALLOWED_CONNECTIONS  Comma-separated whitelist of connection IDs or names
  HOPSQL_DISABLED_TOOLS       Comma-separated list of tools to disable
  HOPSQL_SSH_KNOWN_HOSTS      known_hosts used to verify SSH tunnel hosts (default: ~/.ssh/known_hosts)
  HOPSQL_SSH_STRICT_HOST_KEY  Refuse SSH tunnel hosts with no known_hosts entry (default: true)
  HOPSQL_OPENVPN_CONNECT      Path to the OpenVPN Connect executable, if not installed in the default place
  HOPSQL_DOCKER_PATH          Path to the docker CLI, for VPNs run in a container

Features:
  - Direct database instances with independent permissions; optional saved-workspace import
  - SSH tunnels and URL-mode connections honoured as the DB client configures them
  - Read and write operations with safety checks
  - Schema introspection and table management
  - Data export in multiple formats
  - Business insights tracking
  - Resource-based schema browsing

For more information, visit: https://github.com/kylepantall/hopsql
`);
  process.exit(0);
}

if (process.argv.includes('--version')) {
  console.error(VERSION);
  process.exit(0);
}

// Register operator paths before constructing policy/configuration objects: startup
// failures can happen before any connection has been discovered.
for (const name of [
  'HOPSQL_CONFIG_FILE',
  'HOPSQL_POLICY_FILE',
  'HOPSQL_WORKSPACE',
  'HOPSQL_SSH_KNOWN_HOSTS',
])
  registerPrivateValue(process.env[name]);

try {
  const { startServer } = await import('./server.js');
  await startServer();
} catch (error) {
  console.error('Server startup failed:', sanitizeDiagnostic(error));
  process.exitCode = 1;
}
