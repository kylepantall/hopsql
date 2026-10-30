import { spawn } from 'node:child_process';
import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { readConnectionProp } from '../auth/connection-props.js';
import { isIamAuthConnection, resolveIamCredentials } from '../auth/iam-auth.js';
import { mysqlCliSsl, postgresCliSsl } from '../auth/ssl.js';
import { clientInvocation } from '../install.js';
import { sshTunnelManager } from '../net/ssh-tunnel.js';
import { tableNameParts } from '../metadata/identifiers.js';
import { sqlDialect } from '../policy/analyzer.js';
import { sanitizeDiagnostic } from '../privacy.js';
import type {
  DatabaseConnection,
  DumpBinary,
  DumpCommand,
  DumpErrorCode,
  DumpFlavor,
  DumpOptions,
  DumpTarget,
} from '../types.js';

/** Dump failures carry a stable `code` so callers never parse the message. */
export class DumpError extends Error {
  constructor(
    readonly code: DumpErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'DumpError';
  }
}

export function dumpFlavorFor(driver: string): DumpFlavor | null {
  const dialect = sqlDialect(driver);
  if (dialect === 'postgres') return 'postgres';
  if (dialect === 'mysql') return driver.toLowerCase().includes('mariadb') ? 'mariadb' : 'mysql';
  return null;
}

export function dumpInstallHint(flavor: DumpFlavor, platform = process.platform): string {
  if (flavor === 'postgres')
    return platform === 'win32'
      ? 'winget install PostgreSQL.PostgreSQL (or the client-only installer), or set HOPSQL_PG_DUMP_PATH'
      : platform === 'darwin'
        ? 'brew install libpq and add its bin directory to PATH, or set HOPSQL_PG_DUMP_PATH'
        : 'install the PostgreSQL client package (pg_dump), or set HOPSQL_PG_DUMP_PATH';
  return platform === 'win32'
    ? 'winget install MariaDB.Server (or the MySQL/MariaDB client-only installer), or set HOPSQL_MYSQLDUMP_PATH'
    : platform === 'darwin'
      ? 'brew install mariadb-connector-c mariadb or brew install mysql-client, or set HOPSQL_MYSQLDUMP_PATH'
      : 'install the MariaDB or MySQL client package (mariadb-dump/mysqldump), or set HOPSQL_MYSQLDUMP_PATH';
}

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the dump client: an explicit `HOPSQL_PG_DUMP_PATH` / `HOPSQL_MYSQLDUMP_PATH`
 * wins, otherwise PATH. MariaDB connections prefer `mariadb-dump`.
 */
export function resolveDumpBinary(
  flavor: DumpFlavor,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
): DumpBinary {
  const variable = flavor === 'postgres' ? 'HOPSQL_PG_DUMP_PATH' : 'HOPSQL_MYSQLDUMP_PATH';
  const override = env[variable]?.trim();
  const names =
    flavor === 'postgres'
      ? ['pg_dump']
      : flavor === 'mariadb'
        ? ['mariadb-dump', 'mysqldump']
        : ['mysqldump', 'mariadb-dump'];
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  const directories = (env.PATH ?? env.Path ?? '')
    .split(platform === 'win32' ? ';' : path.delimiter)
    .filter((dir) => dir && path.isAbsolute(dir));
  const candidates = override
    ? [override]
    : names.flatMap((name) =>
        directories.flatMap((dir) => extensions.map((ext) => path.join(dir, name + ext)))
      );
  const found = candidates.find(executable);
  if (!found)
    throw new DumpError(
      'DUMP_TOOL_MISSING',
      `${names.join(' or ')} was not found; ${dumpInstallHint(flavor, platform)}`,
      { tool: names[0], envVar: variable, install: dumpInstallHint(flavor, platform) }
    );
  let real = found;
  try {
    real = realpathSync(found);
  } catch {
    // Keep the configured path; flavor detection falls back to its name.
  }
  // Homebrew and most distributions ship mysqldump as a link to mariadb-dump.
  const resolved =
    flavor === 'postgres'
      ? 'postgres'
      : /mariadb/i.test(path.basename(real)) || /mariadb/i.test(path.basename(found))
        ? 'mariadb'
        : 'mysql';
  return { path: found, flavor: resolved };
}

const BASE_ENV = [
  'PATH',
  'Path',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'USERPROFILE',
];

/** A minimal child environment: no inherited database credentials or service files. */
function baseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    BASE_ENV.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]!]]))
  );
}

function checkName(value: string, label: string): string {
  if (!value || value.startsWith('-') || /[\0\r\n]/.test(value))
    throw new DumpError('DUMP_INVALID_OPTIONS', `Invalid ${label}`, { field: label });
  return value;
}

/** pg_dump `--table` patterns: quote every part so names never act as wildcards. */
function postgresPattern(table: string): string {
  return tableNameParts(table)
    .map((part) => '"' + part.replace(/"/g, '""') + '"')
    .join('.');
}

/** mysqldump takes bare table names inside the selected database. */
function mysqlTable(table: string, database: string): string {
  const parts = tableNameParts(table);
  if (parts.length > 2 || (parts.length === 2 && parts[0] !== database))
    throw new DumpError('DUMP_INVALID_OPTIONS', 'Tables must belong to the selected database', {
      field: 'tables',
    });
  return checkName(parts.at(-1)!, 'table');
}

function optionValue(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

/**
 * Build a shell-free pg_dump / mysqldump / mariadb-dump invocation. Passwords go
 * to `PGPASSWORD`, `MYSQL_PWD` (MariaDB on Windows) or a private option file,
 * never argv.
 */
export function buildDumpCommand(
  binary: DumpBinary,
  target: DumpTarget,
  options: DumpOptions,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
): DumpCommand {
  if (options.schemaOnly && options.dataOnly)
    throw new DumpError('DUMP_INVALID_OPTIONS', 'schemaOnly and dataOnly are mutually exclusive', {
      field: 'schemaOnly',
    });
  const childEnv = baseEnv(env);
  const tables = options.tables ?? [];
  const ssl = target.ssl;
  if (binary.flavor === 'postgres') {
    // Verifying the certificate through a tunnel needs the real name for the
    // identity check while dialing the loopback forward.
    const viaAddress =
      target.tunneled && ssl?.mode === 'verify-full' && target.serverName !== undefined;
    const args = [
      '--no-password',
      '--format=plain',
      `--host=${checkName(viaAddress ? target.serverName! : target.host, 'host')}`,
      `--port=${target.port}`,
      `--username=${checkName(target.user, 'user')}`,
      ...(options.schemaOnly ? ['--schema-only'] : []),
      ...(options.dataOnly ? ['--data-only'] : []),
      ...tables.map((table) => `--table=${postgresPattern(table)}`),
    ];
    Object.assign(childEnv, {
      // PGDATABASE is never expanded as a connection string, unlike --dbname.
      ...(target.database ? { PGDATABASE: target.database } : {}),
      ...(viaAddress ? { PGHOSTADDR: target.host } : {}),
      ...(target.password ? { PGPASSWORD: target.password } : {}),
      PGPASSFILE: devNull,
      PGCONNECT_TIMEOUT: '15',
      ...(ssl ? { PGSSLMODE: ssl.mode } : {}),
      ...(ssl?.ca ? { PGSSLROOTCERT: ssl.ca } : {}),
      ...(ssl?.cert ? { PGSSLCERT: ssl.cert } : {}),
      ...(ssl?.key ? { PGSSLKEY: ssl.key } : {}),
    });
    return { command: binary.path, args, env: childEnv };
  }

  if (!target.database)
    throw new DumpError('DUMP_INVALID_OPTIONS', 'MySQL dumps need a database', {
      field: 'database',
    });
  const database = checkName(target.database, 'database');
  const mariadb = binary.flavor === 'mariadb';
  const passwordEnv = platform === 'win32' && mariadb;
  // Through a tunnel the client dials 127.0.0.1, which never matches the
  // certificate name, and these clients have no PGHOSTADDR equivalent. Keep
  // the CA check and drop only the hostname check (MySQL VERIFY_CA; MariaDB's
  // --ssl-verify-server-cert covers the hostname, so it goes).
  const unverifiedName =
    target.tunneled &&
    (mariadb ? ssl?.mode.startsWith('VERIFY') === true : ssl?.mode === 'VERIFY_IDENTITY');
  const sslArgs = !ssl
    ? []
    : mariadb
      ? [
          ssl.mode === 'DISABLED' ? '--skip-ssl' : '--ssl',
          ...(ssl.mode.startsWith('VERIFY') && !unverifiedName ? ['--ssl-verify-server-cert'] : []),
        ]
      : [`--ssl-mode=${unverifiedName ? 'VERIFY_CA' : ssl.mode}`];
  if (ssl && ssl.mode !== 'DISABLED') {
    if (ssl.ca) sslArgs.push(`--ssl-ca=${ssl.ca}`);
    if (ssl.cert) sslArgs.push(`--ssl-cert=${ssl.cert}`);
    if (ssl.key) sslArgs.push(`--ssl-key=${ssl.key}`);
  }
  const args = [
    ...(passwordEnv ? ['--no-defaults'] : []),
    '--protocol=TCP',
    `--host=${checkName(target.host, 'host')}`,
    `--port=${target.port}`,
    ...(passwordEnv ? [`--user=${checkName(target.user, 'user')}`] : []),
    '--single-transaction',
    '--no-tablespaces',
    ...(mariadb ? [] : ['--set-gtid-purged=OFF']),
    ...(target.cleartextAuth && !mariadb ? ['--enable-cleartext-plugin'] : []),
    ...sslArgs,
    ...(options.schemaOnly ? ['--no-data'] : []),
    ...(options.dataOnly ? ['--no-create-info'] : []),
    database,
    ...tables.map((table) => mysqlTable(table, database)),
  ];
  // --defaults-file still reads ~/.mylogin.cnf, whose credentials would
  // override ours; point the login path file at the null device.
  childEnv.MYSQL_TEST_LOGIN_FILE = devNull;
  const tls = unverifiedName ? { tlsHostnameVerified: false as const } : {};
  if (passwordEnv) {
    if (target.password) childEnv.MYSQL_PWD = target.password;
    return { command: binary.path, args, env: childEnv, ...tls };
  }
  // --defaults-file (prepended by runDump) also stops ~/.my.cnf from being read.
  const defaultsFile =
    '[client]\n' +
    `user=${optionValue(checkName(target.user, 'user'))}\n` +
    (target.password ? `password=${optionValue(target.password)}\n` : '');
  return { command: binary.path, args, env: childEnv, defaultsFile, ...tls };
}

export interface DumpTargetOptions {
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the shared SSH tunnel manager. */
  resolveEndpoint?: (
    connection: DatabaseConnection,
    defaultPort: number
  ) => Promise<{ host: string; port: number } | null>;
}

/**
 * Resolve the endpoint, credentials and TLS mode a dump client should use,
 * matching the pooled driver: SSH tunnels, IAM tokens and env fallbacks.
 */
export async function resolveDumpTarget(
  connection: DatabaseConnection,
  flavor: DumpFlavor,
  options: DumpTargetOptions = {}
): Promise<DumpTarget> {
  const env = options.env ?? process.env;
  const postgres = flavor === 'postgres';
  const defaultPort = postgres ? 5432 : 3306;
  const tunnel = await (
    options.resolveEndpoint ?? ((c, port) => sshTunnelManager.resolveEndpoint(c, port))
  )(connection, defaultPort);
  const iamAuth = isIamAuthConnection(connection);
  const ssl = postgres ? postgresCliSsl(connection, iamAuth) : mysqlCliSsl(connection, iamAuth);
  const iam = iamAuth
    ? await resolveIamCredentials(connection, defaultPort, { debug: options.debug })
    : undefined;
  return {
    host: tunnel?.host ?? (connection.host || 'localhost'),
    port: tunnel?.port ?? (connection.port || defaultPort),
    tunneled: tunnel !== null,
    serverName:
      readConnectionProp(connection, 'ssl.serverName', 'sslServerName') ?? connection.host,
    database: connection.database || connection.properties?.database,
    user:
      iam?.user ||
      connection.user ||
      connection.properties?.user ||
      (postgres ? env.PGUSER || 'postgres' : env.MYSQL_USER || 'root'),
    password:
      iam?.password ??
      (connection.properties?.password ||
        (postgres ? env.PGPASSWORD : env.MYSQL_PWD || env.MYSQL_PASSWORD)),
    ...(ssl ? { ssl } : {}),
    ...(iamAuth && !postgres ? { cleartextAuth: true } : {}),
  };
}

export interface DumpRunOptions {
  timeoutMs: number;
  /** Uncompressed stdout bytes. */
  maxBytes: number;
  sink: Writable;
  platform?: NodeJS.Platform;
}

/** Run a dump client without a shell, streaming stdout into `sink` within the caps. */
export async function runDump(
  command: DumpCommand,
  options: DumpRunOptions
): Promise<{ bytes: number }> {
  const platform = options.platform ?? process.platform;
  const shim = platform === 'win32' && /\.(cmd|bat)$/i.test(command.command);
  // cmd.exe cannot pass a literal `"` through a batch shim intact, and pg_dump
  // table patterns are always quoted; fail before running anything.
  if (shim && [...(command.prefixArgs ?? []), ...command.args].some((arg) => arg.includes('"')))
    throw new DumpError(
      'DUMP_INVALID_OPTIONS',
      'A .cmd/.bat dump client cannot take quoted arguments; point the path setting at the .exe client',
      { field: 'tables' }
    );
  let directory: string | undefined;
  try {
    let args = command.args;
    if (command.defaultsFile !== undefined) {
      // A per-call private directory: Windows ignores 0600, so isolation comes
      // from the per-user temp location and removal in finally.
      directory = await fs.mkdtemp(path.join(tmpdir(), 'hopsql-dump-'));
      await fs.chmod(directory, 0o700);
      const file = path.join(directory, 'client.cnf');
      const handle = await fs.open(
        file,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      );
      try {
        await handle.writeFile(command.defaultsFile);
      } finally {
        await handle.close();
      }
      args = [`--defaults-file=${file}`, ...args];
    }
    args = [...(command.prefixArgs ?? []), ...args];
    let executable = command.command;
    let env = command.env;
    let verbatim = false;
    if (shim) {
      const invocation = clientInvocation(executable, args, platform);
      const slots = Object.entries(invocation.env).filter(
        ([name]) => name.startsWith('HOPSQL_INSTALL_ARG_') || name === 'ComSpec'
      );
      executable = invocation.command;
      args = invocation.args;
      env = { ...env, ...Object.fromEntries(slots as [string, string][]) };
      verbatim = true;
    }
    return await spawnDump(executable, args, env, verbatim, options);
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

function spawnDump(
  executable: string,
  args: string[],
  env: Record<string, string>,
  verbatim: boolean,
  options: DumpRunOptions
): Promise<{ bytes: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    let bytes = 0;
    let stderr = '';
    let failure: DumpError | undefined;
    const fail = (error: DumpError) => {
      if (failure) return;
      failure = error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () =>
        fail(
          new DumpError('DUMP_TIMEOUT', `Dump timed out after ${options.timeoutMs}ms`, {
            timeoutMs: options.timeoutMs,
          })
        ),
      options.timeoutMs
    );
    child.on('error', (error: NodeJS.ErrnoException) =>
      fail(
        error.code === 'ENOENT' || error.code === 'EACCES'
          ? new DumpError('DUMP_TOOL_MISSING', 'Dump client could not be started', {
              errno: error.code,
            })
          : new DumpError('DUMP_FAILED', 'Dump client could not be started', {
              errno: error.code,
            })
      )
    );
    options.sink.on('error', (error) =>
      fail(new DumpError('DUMP_FAILED', 'Dump output could not be stored', { cause: error.name }))
    );
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        fail(
          new DumpError('DUMP_OUTPUT_LIMIT', 'Dump exceeds its byte limit', {
            maxBytes: options.maxBytes,
          })
        );
        return;
      }
      if (!options.sink.write(chunk)) {
        child.stdout.pause();
        options.sink.once('drain', () => child.stdout.resume());
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16384) stderr += chunk.toString('utf8');
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0)
        return reject(
          new DumpError('DUMP_FAILED', 'Dump client failed', {
            exitCode: code,
            signal,
            stderr: sanitizeDiagnostic(stderr.slice(0, 16384).trim()),
          })
        );
      resolve({ bytes });
    });
  });
}
