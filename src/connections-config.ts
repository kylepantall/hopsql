import type {
  AwsSecretConfig,
  ConnectionOverride,
  DatabaseConnection,
  ManagedSettings,
  SsmConfig,
  WriteAccess,
} from './types.js';
import { WRITE_ACCESS_MODES } from './types.js';
import { validateAccessRule } from './policy/access.js';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { readPrivateFile } from './runtime/private-file.js';

const KEYS = [
  'name',
  'driver',
  'host',
  'port',
  'database',
  'user',
  'urlEnv',
  'readOnly',
  'policy',
  'limits',
  'properties',
  'passwordEnv', // Environment variable reference, never a literal credential.
  'ssm',
  'awsSecret',
];
const LIMITS: Record<string, [number, number]> = {
  maxRows: [1, 100000],
  maxBytes: [1024, 8388608],
  timeoutMs: [1, 300000],
  poolMax: [1, 32],
};
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const PROFILE = /^[A-Za-z0-9_][A-Za-z0-9_.+=,@-]{0,127}$/;
function awsScope(value: Record<string, unknown>, label: string): void {
  if (
    value.region !== undefined &&
    (typeof value.region !== 'string' || !REGION.test(value.region))
  )
    throw new Error(`${label}: invalid region`);
  if (
    value.profile !== undefined &&
    (typeof value.profile !== 'string' || !PROFILE.test(value.profile))
  )
    throw new Error(`${label}: invalid profile`);
}
/**
 * Validate an SSM hop. Every value ends up in the AWS CLI's argv, so none may
 * start with `-` and be read as an option, and those placed in shorthand
 * parameters or filters may not contain `,` or `=`.
 */
export function parseSsm(value: unknown, label: string): SsmConfig {
  const ssm = object(value, `${label}: ssm`);
  const optional = ['target', 'targetName', 'region', 'profile', 'remoteHost', 'remotePort'];
  if (Object.keys(ssm).some((k) => k !== 'mode' && !optional.includes(k)))
    throw new Error(`${label}: unknown ssm setting`);
  if ((ssm.target === undefined) === (ssm.targetName === undefined))
    throw new Error(`${label}: set exactly one of ssm.target or ssm.targetName`);
  if (
    ssm.target !== undefined &&
    (typeof ssm.target !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_./-]{0,255}$/.test(ssm.target))
  )
    throw new Error(`${label}: ssm.target must be an instance or managed node id`);
  if (
    ssm.targetName !== undefined &&
    (typeof ssm.targetName !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9 _.:/+@-]{0,254}$/.test(ssm.targetName))
  )
    throw new Error(`${label}: ssm.targetName must be a plain instance Name tag`);
  if (ssm.mode !== 'ssh' && ssm.mode !== 'port-forward')
    throw new Error(`${label}: ssm.mode must be "ssh" or "port-forward"`);
  awsScope(ssm, `${label}: ssm`);
  if (
    ssm.remoteHost !== undefined &&
    (typeof ssm.remoteHost !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,253}$/.test(ssm.remoteHost))
  )
    throw new Error(`${label}: ssm.remoteHost must be a plain hostname or IP address`);
  if (
    ssm.remotePort !== undefined &&
    (!Number.isInteger(ssm.remotePort) ||
      (ssm.remotePort as number) < 1 ||
      (ssm.remotePort as number) > 65535)
  )
    throw new Error(`${label}: invalid ssm.remotePort`);
  if ((ssm.remoteHost !== undefined || ssm.remotePort !== undefined) && ssm.mode !== 'port-forward')
    throw new Error(`${label}: ssm.remoteHost and ssm.remotePort need mode "port-forward"`);
  return {
    mode: ssm.mode,
    ...Object.fromEntries(optional.filter((k) => ssm[k] !== undefined).map((k) => [k, ssm[k]])),
  } as SsmConfig;
}
/** Validate a Secrets Manager reference; the id is passed as one argv value. */
export function parseAwsSecret(value: unknown, label: string): AwsSecretConfig {
  const secret = object(value, `${label}: awsSecret`);
  if (Object.keys(secret).some((k) => !['secretId', 'region', 'profile'].includes(k)))
    throw new Error(`${label}: unknown awsSecret setting`);
  if (
    typeof secret.secretId !== 'string' ||
    !/^[A-Za-z0-9/_+=.@:-]{1,2048}$/.test(secret.secretId) ||
    secret.secretId.startsWith('-')
  )
    throw new Error(`${label}: awsSecret.secretId must be a secret name or ARN`);
  awsScope(secret, `${label}: awsSecret`);
  return {
    secretId: secret.secretId,
    ...(secret.region === undefined ? {} : { region: secret.region as string }),
    ...(secret.profile === undefined ? {} : { profile: secret.profile as string }),
  };
}
function env(name: unknown): string | undefined {
  if (name === undefined) return;
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error('Invalid credential environment variable name');
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable is missing: ${name}`);
  return value;
}
function readConfig(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readPrivateFile(file, 1_000_000, 'Connection config'));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error('Invalid connection config JSON; check it locally');
    throw error;
  }
  const config = object(parsed, 'Connection config');
  if (
    config.version !== 1 ||
    Object.keys(config).some(
      (k) =>
        !['version', 'defaults', 'connections', 'overrides', 'tools', 'dumpDirectory'].includes(k)
    )
  )
    throw new Error('Unsupported connection config version or setting');
  return config;
}
/**
 * Settings layered onto connections discovered elsewhere (the DBeaver
 * workspace), keyed by connection id or name.
 */
export function loadConnectionOverrides(
  file = process.env.HOPSQL_CONFIG_FILE
): Record<string, ConnectionOverride> {
  if (!file) return {};
  const config = readConfig(file);
  if (config.overrides === undefined) return {};
  const overrides = object(config.overrides, 'Connection overrides');
  if (Object.keys(overrides).length > 128)
    throw new Error('At most 128 connection overrides can be configured');
  const result: Record<string, ConnectionOverride> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const entry = object(value, `Override ${key}`);
    if (Object.keys(entry).some((k) => !['ssm', 'awsSecret', 'readOnly', 'access'].includes(k)))
      throw new Error(`Unknown setting on override ${key}`);
    if (entry.readOnly !== undefined && typeof entry.readOnly !== 'boolean')
      throw new Error(`Override ${key}: readOnly must be true or false`);
    if (entry.access !== undefined && !WRITE_ACCESS_MODES.includes(entry.access as WriteAccess))
      throw new Error(`Override ${key}: access must be ${WRITE_ACCESS_MODES.join(', ')}`);
    if (entry.access !== undefined && entry.readOnly !== undefined)
      throw new Error(`Override ${key}: set access or readOnly, not both`);
    result[key] = {
      ...(entry.readOnly === undefined ? {} : { readOnly: entry.readOnly }),
      ...(entry.access === undefined ? {} : { access: entry.access as WriteAccess }),
      ...(entry.ssm === undefined ? {} : { ssm: parseSsm(entry.ssm, `Override ${key}`) }),
      ...(entry.awsSecret === undefined
        ? {}
        : { awsSecret: parseAwsSecret(entry.awsSecret, `Override ${key}`) }),
    };
  }
  return result;
}
/** The overrides `hopsql manage` edits; loaded on every start, no registration needed. */
export function managedOverridesPath(): string {
  return (
    process.env.HOPSQL_OVERRIDES_FILE || join(homedir(), '.config', 'hopsql', 'overrides.json')
  );
}

export function loadManagedOverrides(
  file = managedOverridesPath()
): Record<string, ConnectionOverride> {
  return fs.existsSync(file) ? loadConnectionOverrides(file) : {};
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value))
    throw new Error(`${label} must be an absolute path`);
  return value;
}

/** Pinned dump clients and the dump folder from the managed file. */
export function loadManagedSettings(file = managedOverridesPath()): ManagedSettings {
  if (!fs.existsSync(file)) return {};
  const config = readConfig(file);
  const settings: ManagedSettings = {};
  if (config.tools !== undefined) {
    const tools = object(config.tools, 'tools');
    if (Object.keys(tools).some((k) => k !== 'pgDump' && k !== 'mysqldump'))
      throw new Error('Unknown setting in tools');
    settings.tools = {};
    if (tools.pgDump !== undefined)
      settings.tools.pgDump = absolutePath(tools.pgDump, 'tools.pgDump');
    if (tools.mysqldump !== undefined)
      settings.tools.mysqldump = absolutePath(tools.mysqldump, 'tools.mysqldump');
  }
  if (config.dumpDirectory !== undefined)
    settings.dumpDirectory = absolutePath(config.dumpDirectory, 'dumpDirectory');
  return settings;
}

/**
 * Replace the managed file. Written to a private temp file, checked, then
 * renamed, so the server never reads a half-written or invalid file.
 */
function writeManagedFile(
  overrides: Record<string, ConnectionOverride>,
  settings: ManagedSettings,
  file: string
): void {
  const kept = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => Object.keys(value).length > 0)
  );
  const tools = Object.fromEntries(
    Object.entries(settings.tools ?? {}).filter(([, value]) => value)
  );
  const body = {
    version: 1,
    overrides: kept,
    ...(Object.keys(tools).length ? { tools } : {}),
    ...(settings.dumpDirectory ? { dumpDirectory: settings.dumpDirectory } : {}),
  };
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
    throw new Error('Managed overrides will not be written through a symlink');
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    loadConnectionOverrides(temp);
    loadManagedSettings(temp);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export function saveManagedOverrides(
  overrides: Record<string, ConnectionOverride>,
  file = managedOverridesPath()
): void {
  writeManagedFile(overrides, loadManagedSettings(file), file);
}

export function saveManagedSettings(
  settings: ManagedSettings,
  file = managedOverridesPath()
): void {
  writeManagedFile(loadManagedOverrides(file), settings, file);
}

/** The write mode an override sets, if any; `readOnly` is the older spelling. */
export function overrideAccess(override: ConnectionOverride | undefined): WriteAccess | undefined {
  if (override?.access) return override.access;
  if (override?.readOnly !== undefined) return override.readOnly ? 'read-only' : 'writable';
  return undefined;
}

/**
 * Layer an override onto a connection; later settings win. `managed` marks the
 * `hopsql manage` file, whose access setting outranks HOPSQL_READ_ONLY=true.
 */
export function applyOverride(
  connection: DatabaseConnection,
  override: ConnectionOverride | undefined,
  managed = false
): DatabaseConnection {
  if (!override) return connection;
  const access = overrideAccess(override);
  return {
    ...connection,
    ...(override.ssm ? { ssm: override.ssm } : {}),
    ...(override.awsSecret ? { awsSecret: override.awsSecret } : {}),
    ...(access === undefined
      ? {}
      : {
          readonly: access === 'read-only',
          askBeforeWrite: access === 'ask',
          accessManaged: managed,
        }),
  };
}

/** One server can use explicitly configured instances and discovered workspace connections. */
export function loadConfiguredConnections(
  file = process.env.HOPSQL_CONFIG_FILE
): DatabaseConnection[] {
  if (!file) return [];
  const config = readConfig(file);
  const defaults =
    config.defaults === undefined ? {} : object(config.defaults, 'Connection defaults');
  if (Object.keys(defaults).some((k) => !['readOnly', 'policy', 'limits'].includes(k)))
    throw new Error('Unknown connection default');
  const connections = object(config.connections, 'Connections');
  if (Object.keys(connections).length > 128)
    throw new Error('At most 128 connections can be configured');
  return Object.entries(connections).map(([id, value]) => {
    if (
      !id ||
      id.length > 128 ||
      /[\\/]/.test(id) ||
      [...id].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      ['.', '..'].includes(id)
    )
      throw new Error('Invalid configured connection ID');
    const entry = object(value, `Connection ${id}`);
    if (Object.keys(entry).some((k) => !KEYS.includes(k)))
      throw new Error(`Unknown setting on connection ${id}`);
    const merged = { ...defaults, ...entry };
    if (typeof merged.driver !== 'string' || !merged.driver)
      throw new Error(`Connection ${id} requires a driver`);
    for (const k of ['name', 'host', 'database', 'user'])
      if (merged[k] !== undefined && typeof merged[k] !== 'string')
        throw new Error(`Connection ${id}: ${k} must be a string`);
    if (
      merged.port !== undefined &&
      (!Number.isInteger(merged.port) || Number(merged.port) < 1 || Number(merged.port) > 65535)
    )
      throw new Error(`Connection ${id}: invalid port`);
    if (merged.readOnly !== undefined && typeof merged.readOnly !== 'boolean')
      throw new Error(`Connection ${id}: readOnly must be boolean`);
    if (defaults.policy !== undefined) validateAccessRule(defaults.policy);
    if (entry.policy !== undefined) validateAccessRule(entry.policy);
    const limits = {
      ...(defaults.limits === undefined ? {} : object(defaults.limits, 'Default limits')),
      ...(entry.limits === undefined ? {} : object(entry.limits, 'Connection limits')),
    };
    for (const [k, v] of Object.entries(limits))
      if (
        !LIMITS[k] ||
        !Number.isInteger(v) ||
        Number(v) < LIMITS[k][0] ||
        Number(v) > LIMITS[k][1]
      )
        throw new Error(`Connection ${id}: invalid ${k} limit`);
    const properties =
      merged.properties === undefined ? {} : object(merged.properties, 'Connection properties');
    if (Object.values(properties).some((value) => typeof value !== 'string'))
      throw new Error(`Connection ${id}: property values must be strings`);
    let parsed: Partial<DatabaseConnection> = {};
    const rawUrl = env(merged.urlEnv);
    if (rawUrl) {
      const url = new URL(rawUrl);
      if (
        ![
          'postgres:',
          'postgresql:',
          'mysql:',
          'mariadb:',
          'mssql:',
          'clickhouse:',
          'http:',
          'https:',
          'mongodb:',
          'mongodb+srv:',
          'redis:',
          'rediss:',
        ].includes(url.protocol)
      )
        throw new Error(`Connection ${id}: unsupported URL protocol`);
      parsed = {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port ? Number(url.port) : undefined,
        database: decodeURIComponent(url.pathname.slice(1)) || undefined,
        user: decodeURIComponent(url.username) || undefined,
      };
      for (const [key, value] of url.searchParams) properties[key] = value;
      if (url.password) properties.password = decodeURIComponent(url.password);
    }
    const password = env(merged.passwordEnv);
    if (password) properties.password = password;
    return {
      id,
      name: (merged.name as string | undefined) ?? id,
      driver: merged.driver as string,
      url: rawUrl ?? '',
      ...parsed,
      ...(merged.host === undefined ? {} : { host: merged.host as string }),
      ...(merged.port === undefined ? {} : { port: merged.port as number }),
      ...(merged.database === undefined ? {} : { database: merged.database as string }),
      ...(merged.user === undefined ? {} : { user: merged.user as string }),
      readonly: merged.readOnly !== false,
      properties: properties as Record<string, string>,
      accessRules: [defaults.policy, entry.policy].filter(
        (v) => v !== undefined
      ) as DatabaseConnection['accessRules'],
      limits: limits as DatabaseConnection['limits'],
      ...(entry.ssm === undefined ? {} : { ssm: parseSsm(entry.ssm, `Connection ${id}`) }),
      ...(entry.awsSecret === undefined
        ? {}
        : { awsSecret: parseAwsSecret(entry.awsSecret, `Connection ${id}`) }),
    };
  });
}
