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
// Handle CLI arguments
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

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.error(`
Hopsql MCP Server v${VERSION}

Usage: hopsql [options]
       hopsql install [claude|codex|opencode] [--config <file> | --workspace <directory>] [--allow <ids>] [--allow-writes] [--dry-run]

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
  HOPSQL_UPDATE_NOTIFIER      Check npm for updates (default: true; set false to disable)
  HOPSQL_READ_ONLY            Disable all write operations (default: true; false requires connection write permission)
  HOPSQL_ALLOWED_CONNECTIONS  Comma-separated whitelist of connection IDs or names
  HOPSQL_DISABLED_TOOLS       Comma-separated list of tools to disable
  HOPSQL_SSH_KNOWN_HOSTS      known_hosts used to verify SSH tunnel hosts (default: ~/.ssh/known_hosts)
  HOPSQL_SSH_STRICT_HOST_KEY  Refuse SSH tunnel hosts with no known_hosts entry (default: true)

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
