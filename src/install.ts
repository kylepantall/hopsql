import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  intro,
  outro,
  select,
  multiselect,
  text,
  confirm,
  isCancel,
  cancel,
  note,
  password,
} from '@clack/prompts';
import { WorkspaceConfigParser, findWorkspaces, workspaceCandidates } from './config-parser.js';
import { assertNoSymlinks, validateSetupConfig, writeSetupConfig } from './install-config.js';

/**
 * Register this install rather than the upstream npm package: this fork is not
 * published, so `npx omnisql-mcp@latest` would silently run code without it.
 * install.sh exports its launcher; otherwise run this entry point directly.
 */
export function selfLaunch(): string[] {
  const launcher = process.env.HOPSQL_LAUNCHER;
  if (launcher && isAbsolute(launcher) && existsSync(launcher))
    // install.ps1 writes a .cmd shim, which Windows cannot spawn without cmd.
    return /\.(cmd|bat)$/i.test(launcher) ? ['cmd', '/c', launcher] : [launcher];
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  if (!entry || !existsSync(entry))
    throw new Error(
      'Cannot locate the running hopsql entry point; install with scripts/install.sh'
    );
  return [process.execPath, entry];
}

export function buildInstallCommand(
  client: string,
  readOnly = false,
  environment: Record<string, string> = {}
): { command: string; args: string[] } {
  const allowed = new Set([
    'HOPSQL_CONFIG_FILE',
    'HOPSQL_WORKSPACE',
    'HOPSQL_PROJECT',
    'HOPSQL_READ_ONLY',
    'HOPSQL_ALLOWED_CONNECTIONS',
    'HOPSQL_DISCOVER_WORKSPACE',
  ]);
  if (Object.keys(environment).some((key) => !allowed.has(key)))
    throw new Error(
      'Installer environment accepts setup settings only; keep credentials in private configuration or environment references.'
    );
  const launch = selfLaunch();
  const settings = { ...environment, ...(readOnly ? { HOPSQL_READ_ONLY: 'true' } : {}) };
  const env = Object.entries(settings).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  switch (client) {
    case 'claude':
      return {
        command: 'claude',
        args: [
          'mcp',
          'add',
          '--transport',
          'stdio',
          '--scope',
          'user',
          'hopsql',
          ...env,
          '--',
          ...launch,
        ],
      };
    case 'codex':
      return { command: 'codex', args: ['mcp', 'add', ...env, 'hopsql', '--', ...launch] };
    case 'opencode':
      return {
        command: 'opencode',
        args: ['mcp', 'add', 'hopsql', '--global', ...env, '--', ...launch],
      };
    default:
      throw new Error(
        'Choose a client: claude, codex, or opencode. Usage: hopsql install <client> [--read-only] [--dry-run]'
      );
  }
}

/** cmd shims cannot be spawned directly on Windows. Values stay in environment slots,
 * quoted once, instead of being interpolated into cmd's command source. */
export function clientInvocation(command: string, args: string[], platform = process.platform) {
  if (platform !== 'win32') return { command, args, env: process.env };
  const values = [command, ...args];
  if (values.some((value) => /["\r\n]/.test(value)))
    throw new Error('Windows client arguments cannot contain quotes or newlines.');
  const env = { ...process.env };
  values.forEach((value, index) => {
    env[`HOPSQL_INSTALL_ARG_${index}`] = value;
  });
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: [
      '/d',
      '/v:off',
      '/s',
      '/c',
      '"' + values.map((_, index) => `"%HOPSQL_INSTALL_ARG_${index}%"`).join(' ') + '"',
    ],
    env,
  };
}

/** Commands that remove an existing registration, where the client CLI has one. */
export function buildRemoveCommand(
  client: string
): { command: string; args: string[] } | undefined {
  if (client === 'claude')
    return { command: 'claude', args: ['mcp', 'remove', 'hopsql', '--scope', 'user'] };
  if (client === 'codex') return { command: 'codex', args: ['mcp', 'remove', 'hopsql'] };
  return undefined;
}

function runClient(command: string, args: string[], stdio: 'inherit' | 'ignore' = 'inherit') {
  const invocation = clientInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    stdio,
    shell: false,
    env: invocation.env,
    windowsVerbatimArguments: process.platform === 'win32',
  });
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT') {
      throw new Error(
        `${command} is not installed or is not on PATH. Install the client first, then rerun this command.`
      );
    }
    throw new Error(`${command} could not start. Check that the client is installed and on PATH.`);
  }
  return result;
}

/** Remove an existing registration so a replacement can be added under the same name. */
function removeClientEntry(client: string): void {
  const remove = buildRemoveCommand(client);
  if (!remove)
    throw new Error(
      `Remove the existing hopsql entry from ${client}'s MCP settings, then run setup again.`
    );
  const result = runClient(remove.command, remove.args);
  if (result.status !== 0)
    throw new Error(
      `${remove.command} could not remove the existing hopsql entry (exit ${result.status ?? result.signal}).`
    );
}

export function hasClientEntry(client: string): boolean {
  try {
    assertClientDestination(client);
    return false;
  } catch (error) {
    if (error instanceof ExistingEntryError) return true;
    throw error;
  }
}

export class ExistingEntryError extends Error {}

function assertClientDestination(client: string): void {
  const home = homedir();
  const candidates =
    client === 'codex'
      ? [join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml')]
      : client === 'claude'
        ? [
            join(home, '.claude.json'),
            ...(process.env.CLAUDE_CONFIG_DIR
              ? [join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')]
              : []),
          ]
        : [
            join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'opencode.json'),
            join(
              process.env.XDG_CONFIG_HOME || join(home, '.config'),
              'opencode',
              'opencode.jsonc'
            ),
            ...(process.env.OPENCODE_CONFIG ? [process.env.OPENCODE_CONFIG] : []),
          ];
  for (const file of candidates) {
    assertNoSymlinks(file);
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    // Conservatively refuse any existing Hopsql entry, including JSONC and quoted TOML names.
    if (
      client === 'codex'
        ? /\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:hopsql|"hopsql"|'hopsql')(?:\s*[.\]])/.test(
            content
          )
        : /"hopsql"\s*:/.test(content)
    )
      throw new ExistingEntryError(
        'A hopsql entry already exists. Keep it, or replace it: rerun with --replace (or answer yes in guided setup).'
      );
  }
}

export function installClient(args: string[], environment: Record<string, string> = {}): void {
  const [client, ...flags] = args;
  const settings = { ...environment };
  if (flags.includes('--read-only') && flags.includes('--allow-writes'))
    throw new Error('Choose either --read-only or --allow-writes.');
  let readOnly = true;
  let dryRun = false;
  let replace = false;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === '--read-only') readOnly = true;
    else if (flag === '--allow-writes') readOnly = false;
    else if (flag === '--dry-run') dryRun = true;
    else if (flag === '--replace') replace = true;
    else if (['--config', '--workspace', '--allow'].includes(flag)) {
      const value = flags[++index];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
      if (flag === '--config') settings.HOPSQL_CONFIG_FILE = expandPath(value);
      else if (flag === '--workspace') {
        settings.HOPSQL_WORKSPACE = expandPath(value);
        settings.HOPSQL_DISCOVER_WORKSPACE = 'true';
      } else settings.HOPSQL_ALLOWED_CONNECTIONS = value;
    } else
      throw new Error(
        'Supported install options: --read-only, --allow-writes, --dry-run, --replace, --config <file>, --workspace <directory>, --allow <ids>'
      );
  }
  if (settings.HOPSQL_CONFIG_FILE && settings.HOPSQL_WORKSPACE)
    throw new Error('Choose either --config or --workspace for setup.');
  if (settings.HOPSQL_CONFIG_FILE) {
    const ids = validateSetupConfig(settings.HOPSQL_CONFIG_FILE);
    settings.HOPSQL_DISCOVER_WORKSPACE = 'false';
    if (
      settings.HOPSQL_ALLOWED_CONNECTIONS &&
      settings.HOPSQL_ALLOWED_CONNECTIONS.split(',').some(
        (selector) =>
          !ids.some((id) => selector.trim() === id || selector.trim().startsWith(id + '/'))
      )
    )
      throw new Error(
        'Every --allow selector must identify a configured connection ID (optionally followed by /database).'
      );
    settings.HOPSQL_ALLOWED_CONNECTIONS ||= ids.join(',');
  }
  if (settings.HOPSQL_READ_ONLY === 'false' && !flags.includes('--read-only')) readOnly = false;
  if (!readOnly) settings.HOPSQL_READ_ONLY = 'false';
  const { command, args: commandArgs } = buildInstallCommand(client, readOnly, settings);
  if (
    !dryRun &&
    !settings.HOPSQL_CONFIG_FILE &&
    (!settings.HOPSQL_WORKSPACE || !settings.HOPSQL_ALLOWED_CONNECTIONS?.trim())
  )
    throw new Error(
      'Choose --config <file> or --workspace <directory> --allow <connection IDs>, or run guided setup in a terminal.'
    );
  if (settings.HOPSQL_WORKSPACE && !statSync(settings.HOPSQL_WORKSPACE).isDirectory())
    throw new Error('Workspace must be a directory.');
  console.error([command, ...commandArgs.map((value) => JSON.stringify(value))].join(' '));
  if (dryRun) return;
  if (replace && hasClientEntry(client)) {
    removeClientEntry(client);
    console.error('Removed the existing hopsql entry.');
  }
  assertClientDestination(client);
  const result = runClient(command, commandArgs);
  if (result.status !== 0) {
    throw new Error(
      `${command} could not add Hopsql (exit ${result.status ?? result.signal}). Check the client output above.`
    );
  }
  console.error('Hopsql added. Start a new client session to use it.');
}

function answer<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }
  return value as T;
}

async function workspaceConnections(workspace: string) {
  const previousConfig = process.env.HOPSQL_CONFIG_FILE;
  const previousDiscovery = process.env.HOPSQL_DISCOVER_WORKSPACE;
  try {
    // Setup inspects only the source selected by the person at the terminal.
    delete process.env.HOPSQL_CONFIG_FILE;
    process.env.HOPSQL_DISCOVER_WORKSPACE = 'true';
    return await new WorkspaceConfigParser({ workspacePath: workspace }).parseConnections();
  } catch {
    throw new Error(
      'Cannot read the selected workspace. Check its configuration before registering.'
    );
  } finally {
    if (previousConfig === undefined) delete process.env.HOPSQL_CONFIG_FILE;
    else process.env.HOPSQL_CONFIG_FILE = previousConfig;
    if (previousDiscovery === undefined) delete process.env.HOPSQL_DISCOVER_WORKSPACE;
    else process.env.HOPSQL_DISCOVER_WORKSPACE = previousDiscovery;
  }
}

export async function runInstall(args: string[]): Promise<void> {
  if (args.includes('--config') && args.includes('--workspace'))
    throw new Error('Choose either --config or --workspace for setup.');
  const preselected =
    args.length === 1 &&
    ['claude', 'codex', 'opencode'].includes(args[0]) &&
    process.stdin.isTTY &&
    process.stdout.isTTY
      ? args[0]
      : undefined;
  if (args.length > 0 && !preselected) {
    const workspace = args[args.indexOf('--workspace') + 1];
    if (args.includes('--workspace') && workspace && !args.includes('--dry-run')) {
      const available = await workspaceConnections(expandPath(workspace));
      const selected = args.includes('--allow')
        ? args[args.indexOf('--allow') + 1]?.split(',').map((id) => id.trim())
        : [];
      if (!selected?.length || selected.some((id) => !available.some((entry) => entry.id === id)))
        throw new Error(
          'Select existing workspace connection IDs with --allow before registering.'
        );
    }
    installClient(args);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Interactive setup needs a terminal. Choose a client explicitly: install <claude|codex|opencode> [--read-only] [--dry-run]'
    );
  }
  intro('Hopsql MCP setup');
  const clients = [
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'opencode', label: 'OpenCode' },
  ];
  const detected = preselected
    ? []
    : clients.filter(
        (entry) =>
          spawnSync(entry.value, ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0
      );
  const client =
    preselected ??
    answer(
      await select({
        message: 'Where should Hopsql be added?',
        initialValue: detected[0]?.value,
        // Installed clients first, so Enter picks one that will work.
        options: [...detected, ...clients.filter((entry) => !detected.includes(entry))].map(
          (entry) => ({
            ...entry,
            hint: detected.includes(entry) ? 'detected' : 'not found on this machine',
          })
        ),
      })
    );
  let replace = false;
  if (hasClientEntry(client)) {
    const label = clients.find((entry) => entry.value === client)?.label ?? client;
    if (!buildRemoveCommand(client))
      throw new Error(
        `${label} already has a hopsql entry. Remove it from its MCP settings, then run setup again.`
      );
    replace = answer(
      await confirm({
        message: `${label} already has a hopsql entry. Replace it with the settings you choose next?`,
        initialValue: false,
      })
    );
    if (!replace) {
      cancel('Kept the existing hopsql entry.');
      return;
    }
  }
  const workspaces = process.env.HOPSQL_WORKSPACE
    ? [expandPath(process.env.HOPSQL_WORKSPACE)]
    : findWorkspaces();
  const configs = existingConfigFiles();
  const mode = answer(
    await select({
      message: 'How do you want to connect?',
      // Preselect whatever this machine already has.
      initialValue: workspaces.length ? 'workspace' : configs.length ? 'config' : 'direct',
      options: [
        {
          value: 'workspace',
          label: 'Import selected DBeaver connections',
          hint: workspaces.length ? `found ${workspaces[0]}` : 'no DBeaver workspace found',
        },
        { value: 'direct', label: 'Add database instances directly', hint: 'No DBeaver needed' },
        {
          value: 'config',
          label: 'Use an existing Hopsql configuration',
          hint: configs.length ? `found ${configs[0]}` : undefined,
        },
      ],
    })
  );
  let environment: Record<string, string>;
  if (mode === 'direct') {
    const config = await collectDirectConfig();
    const file = expandPath(
      answer(
        await text({
          message: 'Save private connection configuration to',
          initialValue: freeConfigPath(),
          validate(value) {
            if (!value?.trim()) return 'Enter a file path.';
            if (existsSync(expandPath(value)))
              return 'File already exists. Choose a new file or use the existing-config path.';
          },
        })
      )
    );
    const ids = writeSetupConfig(file, config);
    environment = {
      HOPSQL_CONFIG_FILE: file,
      HOPSQL_DISCOVER_WORKSPACE: 'false',
      HOPSQL_ALLOWED_CONNECTIONS: ids.join(','),
      HOPSQL_READ_ONLY: String(Object.values(config.connections).every((entry) => entry.readOnly)),
    };
    note(
      'Connection settings stay in this private local file (0600 on Unix). Password input is masked and never passed in command arguments. An agent with unrestricted local file access can still read the file.',
      'Local storage'
    );
  } else if (mode === 'config') {
    const file = await choosePath({
      message: 'Hopsql connection configuration',
      found: configs,
      fallback: join(homedir(), '.config', 'hopsql', 'connections.json'),
      validate(value) {
        try {
          validateSetupConfig(value);
        } catch {
          return 'Enter a valid configuration with at least one connection and available credential environment references.';
        }
      },
    });
    environment = {
      HOPSQL_CONFIG_FILE: file,
      HOPSQL_DISCOVER_WORKSPACE: 'false',
      HOPSQL_ALLOWED_CONNECTIONS: validateSetupConfig(file).join(','),
      HOPSQL_READ_ONLY: 'false',
    };
  } else {
    const workspace = await choosePath({
      message: 'DBeaver workspace',
      found: workspaces,
      fallback: workspaceCandidates()[0],
      validate(value) {
        return existsSync(value) ? undefined : 'Directory not found.';
      },
    });
    const available = await workspaceConnections(workspace);
    if (!available.length)
      throw new Error('No saved connections found in that workspace. Save one in DBeaver first.');
    const ids = answer(
      await multiselect({
        message: 'Connections the agent may use (space to toggle, enter to confirm)',
        required: true,
        options: available.map((connection) => ({
          value: connection.id,
          label: connection.name || connection.id,
          hint: [connection.driver, connection.sshTunnel?.enabled ? 'SSH' : undefined]
            .filter(Boolean)
            .join(' · '),
        })),
      })
    );
    const readOnly = answer(
      await confirm({ message: 'Allow read-only queries only?', initialValue: true })
    );
    environment = {
      HOPSQL_WORKSPACE: workspace,
      HOPSQL_DISCOVER_WORKSPACE: 'true',
      HOPSQL_ALLOWED_CONNECTIONS: ids.join(','),
      HOPSQL_READ_ONLY: String(readOnly),
    };
  }
  installClient(replace ? [client, '--replace'] : [client], environment);
  outro('Ready. Start a new client session, then ask it to list your database connections.');
}

type DirectEntry = {
  driver: string;
  readOnly: boolean;
  database: string;
  host?: string;
  port?: number;
  user?: string;
  passwordEnv?: string;
  properties: Record<string, string>;
  policy?: { allowTables?: string[]; denyTables?: string[] };
  limits: { maxRows: number; timeoutMs: number };
};
async function collectDirectConfig(): Promise<{
  version: 1;
  connections: Record<string, DirectEntry>;
}> {
  const connections: Record<string, DirectEntry> = Object.create(null);
  do {
    const driver = answer(
      await select({
        message: 'Database engine',
        initialValue: 'postgresql',
        options: [
          { value: 'postgresql', label: 'PostgreSQL' },
          { value: 'mysql', label: 'MySQL' },
          { value: 'mariadb', label: 'MariaDB' },
          { value: 'mssql', label: 'SQL Server' },
          { value: 'oracle', label: 'Oracle' },
          { value: 'sqlite', label: 'SQLite', hint: 'local file' },
          { value: 'duckdb', label: 'DuckDB', hint: 'local file' },
          { value: 'clickhouse', label: 'ClickHouse' },
        ],
      })
    );
    const suggested = DRIVER_DEFAULTS[driver];
    const local = driver === 'sqlite' || driver === 'duckdb';
    const entry: DirectEntry = {
      driver,
      readOnly: true,
      database: '',
      properties: {},
      limits: { maxRows: 1000, timeoutMs: 30000 },
    };
    if (!local) {
      entry.host = answer(
        await text({
          message: 'Database hostname',
          initialValue: 'localhost',
          validate(value) {
            return value && !/[\s/@?#]/.test(value)
              ? undefined
              : 'Enter a hostname, without a URI or credentials.';
          },
        })
      );
      entry.port = Number(
        answer(
          await text({
            message: 'Port',
            initialValue: String(suggested.port),
            validate(value) {
              return value && /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535
                ? undefined
                : 'Use a port between 1 and 65535.';
            },
          })
        )
      );
      entry.user = answer(
        await text({
          message: 'Database username',
          initialValue: suggested.user,
          validate(value) {
            return value?.trim() ? undefined : 'Enter a username.';
          },
        })
      );
      const credentials = answer(
        await select({
          message: 'Database credentials',
          initialValue: 'private',
          options: [
            {
              value: 'private',
              label: 'Enter password (masked)',
              hint: 'Stored in the private local configuration',
            },
            {
              value: 'env',
              label: 'Reference an existing environment variable',
              hint: 'Must also be available to the client at runtime',
            },
            {
              value: 'none',
              label: 'No password',
              hint: 'Configure advanced authentication in the JSON file',
            },
          ],
        })
      );
      if (credentials === 'private') {
        const value = answer(
          await password({
            message: 'Database password (stored locally, never in client arguments)',
          })
        );
        if (value) entry.properties.password = value;
      } else if (credentials === 'env') {
        // Offer variables that look like passwords; values are never shown.
        const candidates = Object.keys(process.env)
          .filter((name) => /PASS|PWD|SECRET|TOKEN/i.test(name) && process.env[name])
          .sort();
        const picked = candidates.length
          ? answer(
              await select({
                message: 'Password environment variable',
                options: [
                  ...candidates.map((name) => ({ value: name, label: name })),
                  { value: OTHER, label: 'Another variable…' },
                ],
              })
            )
          : OTHER;
        entry.passwordEnv =
          picked !== OTHER
            ? picked
            : answer(
                await text({
                  message: 'Password environment variable name',
                  initialValue: `${driver.toUpperCase()}_PASSWORD`,
                  validate(value) {
                    return value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && process.env[value]
                      ? undefined
                      : 'Enter the name of an available environment variable.';
                  },
                })
              );
      }
      const tls = answer(
        await confirm({ message: 'Use TLS with verified server certificates?', initialValue: true })
      );
      if (driver === 'postgresql' || driver === 'mysql' || driver === 'mariadb')
        entry.properties.sslmode = tls ? 'verify-full' : 'disable';
      if (driver === 'mssql') {
        entry.properties.encrypt = String(tls);
        entry.properties.trustServerCertificate = 'false';
      }
      if (driver === 'clickhouse') entry.properties.ssl = String(tls);
      if (driver === 'oracle') entry.properties.protocol = tls ? 'tcps' : 'tcp';
    }
    entry.database = answer(
      await text({
        message: local ? 'Existing database file path' : 'Database name / service',
        initialValue: local ? process.cwd() + '/' : suggested.database,
        validate(value) {
          if (!value?.trim()) return 'A database is required.';
          if (local && !existsSync(expandPath(value))) return 'Database file not found.';
        },
      })
    );
    if (local) entry.database = expandPath(entry.database);
    const id = answer(
      await text({
        message: 'Connection ID (visible to the agent)',
        initialValue: suggestConnectionId(driver, entry.database, connections),
        validate(value) {
          return value &&
            /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) &&
            !Object.hasOwn(connections, value)
            ? undefined
            : 'Use a unique ID with letters, numbers, dots, underscores or hyphens.';
        },
      })
    );
    entry.readOnly = answer(
      await confirm({ message: `Keep ${id} read-only?`, initialValue: true })
    );
    const tables = answer(
      await select({
        message: 'Which tables may the agent see?',
        initialValue: 'all',
        options: [
          { value: 'all', label: 'All tables' },
          { value: 'allowTables', label: 'Only specific tables…' },
          { value: 'denyTables', label: 'All except specific tables…' },
        ],
      })
    );
    if (tables !== 'all') {
      const value = answer(
        await text({
          message: tables === 'allowTables' ? 'Allowed tables' : 'Blocked tables',
          placeholder: 'public.orders, public.customers',
          validate(input) {
            return input?.trim() ? undefined : 'Enter at least one table, comma-separated.';
          },
        })
      );
      entry.policy = {
        [tables]: value
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      };
    }
    connections[id] = entry;
  } while (
    Object.keys(connections).length < 128 &&
    answer(await confirm({ message: 'Add another database instance?', initialValue: false }))
  );
  return { version: 1, connections };
}

const OTHER = '\u0000other';

/** Prefilled answers for direct setup, so Enter gives a working local default. */
const DRIVER_DEFAULTS: Record<string, { port?: number; user?: string; database?: string }> = {
  postgresql: { port: 5432, user: 'postgres', database: 'postgres' },
  mysql: { port: 3306, user: 'root', database: 'mysql' },
  mariadb: { port: 3306, user: 'root', database: 'mysql' },
  mssql: { port: 1433, user: 'sa', database: 'master' },
  oracle: { port: 1521, user: 'system', database: 'FREEPDB1' },
  clickhouse: { port: 8443, user: 'default', database: 'default' },
  sqlite: {},
  duckdb: {},
};

/** A readable, unique ID such as "postgresql-orders". */
export function suggestConnectionId(
  driver: string,
  database: string,
  taken: Record<string, unknown>
): string {
  const name = (database.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '');
  const base = `${driver}-${name}`.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/-+$/, '') || driver;
  let id = base;
  for (let n = 2; Object.hasOwn(taken, id); n++) id = `${base}-${n}`;
  return id;
}

/** Hopsql (and legacy OmniSQL) configuration files that already exist. */
export function existingConfigFiles(home = homedir(), env = process.env): string[] {
  return [
    env.HOPSQL_CONFIG_FILE,
    join(home, '.config', 'hopsql', 'connections.json'),
    join(home, '.config', 'omnisql', 'connections.json'),
  ].filter(
    (file, index, all): file is string =>
      !!file && all.indexOf(file) === index && existsSync(expandPath(file))
  );
}

/** The default config path, or the first numbered variant that is still free. */
export function freeConfigPath(home = homedir()): string {
  const base = join(home, '.config', 'hopsql', 'connections');
  if (!existsSync(`${base}.json`)) return `${base}.json`;
  let n = 2;
  while (existsSync(`${base}-${n}.json`)) n++;
  return `${base}-${n}.json`;
}

/** Pick a detected path from a list, falling back to a prefilled text answer. */
async function choosePath(options: {
  message: string;
  found: string[];
  fallback: string;
  validate: (path: string) => string | undefined;
}): Promise<string> {
  if (options.found.length) {
    const picked = answer(
      await select({
        message: options.message,
        initialValue: options.found[0],
        options: [
          ...options.found.map((value) => ({ value, label: value, hint: 'found' })),
          { value: OTHER, label: 'Another path…' },
        ],
      })
    );
    const problem = picked === OTHER ? undefined : options.validate(picked);
    if (picked !== OTHER && !problem) return picked;
  }
  return expandPath(
    answer(
      await text({
        message: options.message,
        initialValue: options.fallback,
        validate: (value) => (value ? options.validate(expandPath(value)) : 'Enter a path.'),
      })
    )
  );
}

function expandPath(value: string): string {
  return resolve(
    value === '~' ? homedir() : value.startsWith('~/') ? homedir() + value.slice(1) : value
  );
}
