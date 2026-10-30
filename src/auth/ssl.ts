/**
 * TLS configuration shared by the direct-query and pooled connection paths.
 *
 * Keeping one implementation avoids the two drifting: they previously read
 * different property locations and disagreed about what "require" means.
 */

import fs from 'fs';
import { isIP } from 'node:net';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';
import type { CliSslSettings, DatabaseConnection } from '../types.js';
import { readConnectionProp } from './connection-props.js';

/** Modes that authenticate the server certificate, rather than merely encrypting. */
const PG_VERIFY_MODES = ['verify-ca', 'verify-full'];
const MYSQL_VERIFY_MODES = ['verify-ca', 'verify_ca', 'verify-full', 'verify_identity'];

const PG_REQUIRE_MODES = ['require', 'required', 'true', '1', ...PG_VERIFY_MODES];
const MYSQL_REQUIRE_MODES = [
  'require',
  'required',
  'true',
  '1',
  'preferred',
  'enabled',
  'yes',
  ...MYSQL_VERIFY_MODES,
];

const PG_DISABLE_MODES = ['disable', 'disabled', 'false', '0'];
const MYSQL_DISABLE_MODES = ['disable', 'disabled', 'false', '0', 'none', 'off', 'no'];

/** Explicit certificate paths fail closed instead of falling back to other trust. */
function readPem(pathValue: string | undefined): string | undefined {
  if (!pathValue) return;
  try {
    return fs.readFileSync(pathValue, 'utf8');
  } catch {
    throw new Error('Cannot read configured TLS certificate or key file');
  }
}

function buildSslMaterial(
  ca: string | undefined,
  cert: string | undefined,
  key: string | undefined
): Record<string, string> {
  const material: Record<string, string> = {};
  const caPem = readPem(ca);
  const certPem = readPem(cert);
  const keyPem = readPem(key);
  if (caPem) material.ca = caPem;
  if (certPem) material.cert = certPem;
  if (keyPem) material.key = keyPem;
  return material;
}

/** HTTP database TLS always verifies the original target, including through SSH. */
export function resolveHttpTls(connection: DatabaseConnection): ConnectionOptions {
  const host =
    readConnectionProp(connection, 'ssl.serverName') ||
    connection.host ||
    readConnectionProp(connection, 'host');
  if (!host) throw new Error('HTTPS database connections require a hostname');
  return {
    ...buildSslMaterial(
      readConnectionProp(connection, 'sslrootcert', 'ssl.ca'),
      readConnectionProp(connection, 'sslcert', 'ssl.cert'),
      readConnectionProp(connection, 'sslkey', 'ssl.key')
    ),
    rejectUnauthorized: true,
    ...(isIP(host) ? {} : { servername: host }),
    checkServerIdentity: (_, certificate) => checkServerIdentity(host, certificate),
  };
}

/**
 * Resolve the Postgres SSL mode declared by a connection.
 *
 * Besides plain properties, the workspace can express TLS through an
 * `handlers.postgre_ssl` block, whose mere presence implies TLS.
 */
function postgresSslMode(connection: DatabaseConnection): string {
  const direct = readConnectionProp(connection, 'ssl.mode', 'sslmode', 'sslMode', 'ssl');
  if (direct) {
    return direct.toLowerCase();
  }

  const handlers = connection.properties?.['handlers'] as unknown as
    | Record<string, unknown>
    | undefined;
  const sslHandler = handlers?.['postgre_ssl'] as Record<string, unknown> | undefined;
  if (sslHandler?.enabled === true || sslHandler?.enabled === 'true') {
    const handlerMode = (sslHandler.properties as Record<string, unknown> | undefined)?.['sslMode'];
    return String(handlerMode ?? 'require').toLowerCase();
  }

  return '';
}

function mysqlSslHandler(connection: DatabaseConnection): Record<string, unknown> | undefined {
  const handlers = connection.properties?.['handlers'] as unknown as
    | Record<string, unknown>
    | undefined;
  return handlers?.['mysql_ssl'] as Record<string, unknown> | undefined;
}

function mysqlSslHandlerProp(connection: DatabaseConnection, name: string): string | undefined {
  const properties = mysqlSslHandler(connection)?.properties as Record<string, unknown> | undefined;
  const value = properties?.[name];
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Resolve MySQL TLS settings from driver properties or DBeaver's
 * `handlers.mysql_ssl` block. Explicit driver properties take precedence.
 */
function mysqlSslMode(connection: DatabaseConnection): string {
  const direct = readConnectionProp(connection, 'ssl.mode', 'sslMode', 'sslmode', 'useSSL', 'ssl');
  if (direct) {
    return direct.toLowerCase();
  }

  const handler = mysqlSslHandler(connection);
  if (handler?.enabled !== true && handler?.enabled !== 'true') {
    return '';
  }

  const handlerMode = mysqlSslHandlerProp(connection, 'sslMode');
  if (handlerMode) {
    return handlerMode.toLowerCase();
  }

  const verifyServer = mysqlSslHandlerProp(connection, 'ssl.verify.server');
  if (verifyServer?.toLowerCase() === 'true') {
    return 'verify_identity';
  }

  // Enabling DBeaver's MySQL SSL handler means encryption is required even
  // when it stores no explicit sslMode (the common CERTIFICATES-mode shape).
  return 'required';
}

function postgresSslPaths(connection: DatabaseConnection): Omit<CliSslSettings, 'mode'> {
  const handler = (connection.properties?.handlers as unknown as Record<string, any> | undefined)
    ?.postgre_ssl?.properties as Record<string, string> | undefined;
  return {
    ca:
      readConnectionProp(connection, 'sslrootcert', 'ssl.root.cert', 'sslRootCert') ??
      handler?.['ssl.root.cert'] ??
      handler?.['ssl.ca.cert'],
    cert:
      readConnectionProp(connection, 'sslcert', 'ssl.cert', 'sslCert') ??
      handler?.['ssl.cert'] ??
      handler?.['ssl.client.cert'],
    key:
      readConnectionProp(connection, 'sslkey', 'ssl.key', 'sslKey') ??
      handler?.['ssl.key'] ??
      handler?.['ssl.client.key'],
  };
}

function mysqlSslPaths(connection: DatabaseConnection): Omit<CliSslSettings, 'mode'> {
  return {
    ca:
      readConnectionProp(connection, 'ssl.ca', 'sslCA', 'sslrootcert') ??
      mysqlSslHandlerProp(connection, 'ssl.ca.cert'),
    cert:
      readConnectionProp(connection, 'ssl.cert', 'sslCert', 'sslcert') ??
      mysqlSslHandlerProp(connection, 'ssl.client.cert'),
    key:
      readConnectionProp(connection, 'ssl.key', 'sslKey', 'sslkey') ??
      mysqlSslHandlerProp(connection, 'ssl.client.key'),
  };
}

/**
 * The libpq `sslmode` and certificate paths matching `resolvePostgresSsl`, for
 * command line clients. `undefined` mode leaves the client at its own default.
 */
export function postgresCliSsl(
  connection: DatabaseConnection,
  iamAuth = false
): CliSslSettings | undefined {
  const sslMode = postgresSslMode(connection);
  if (PG_DISABLE_MODES.includes(sslMode)) {
    if (iamAuth)
      throw new Error('IAM authentication requires TLS; remove the disabled SSL setting');
    return { mode: 'disable' };
  }
  if (!PG_REQUIRE_MODES.includes(sslMode) && !iamAuth) return undefined;
  const mode = PG_VERIFY_MODES.includes(sslMode)
    ? sslMode
    : iamAuth && !sslMode
      ? 'verify-full'
      : 'require';
  return { mode, ...definedPaths(postgresSslPaths(connection)) };
}

/**
 * MySQL `--ssl-mode` (upper case) and certificate paths matching
 * `resolveMysqlSsl`, for command line clients.
 */
export function mysqlCliSsl(
  connection: DatabaseConnection,
  iamAuth = false
): CliSslSettings | undefined {
  const sslMode = mysqlSslMode(connection);
  if (MYSQL_DISABLE_MODES.includes(sslMode)) {
    if (iamAuth)
      throw new Error('IAM authentication requires TLS; remove the disabled SSL setting');
    return { mode: 'DISABLED' };
  }
  if (!MYSQL_REQUIRE_MODES.includes(sslMode) && !iamAuth) return undefined;
  const paths = definedPaths(mysqlSslPaths(connection));
  const mode =
    (iamAuth && !sslMode) ||
    ['verify-full', 'verify_identity'].includes(sslMode) ||
    (paths.ca && !['verify-ca', 'verify_ca'].includes(sslMode))
      ? 'VERIFY_IDENTITY'
      : ['verify-ca', 'verify_ca'].includes(sslMode)
        ? 'VERIFY_CA'
        : 'REQUIRED';
  return { mode, ...paths };
}

function definedPaths(paths: Omit<CliSslSettings, 'mode'>): Omit<CliSslSettings, 'mode'> {
  return Object.fromEntries(Object.entries(paths).filter(([, value]) => value));
}

/**
 * Build the `ssl` option for a `pg` client or pool.
 *
 * `iamAuth` forces TLS on, because RDS rejects IAM tokens sent in cleartext.
 * Returns `undefined` to leave the driver at its own default.
 */
export function resolvePostgresSsl(
  connection: DatabaseConnection,
  iamAuth = false,
  debug = false
): Record<string, unknown> | false | undefined {
  const sslMode = postgresSslMode(connection);
  const disable = PG_DISABLE_MODES.includes(sslMode);

  if (disable) {
    if (iamAuth)
      throw new Error('IAM authentication requires TLS; remove the disabled SSL setting');
    return false;
  }

  if (!PG_REQUIRE_MODES.includes(sslMode) && !iamAuth) {
    return undefined;
  }

  const paths = postgresSslPaths(connection);
  const material = buildSslMaterial(paths.ca, paths.cert, paths.key);

  const hasCa = typeof material.ca === 'string' && material.ca.length > 0;
  const verify = PG_VERIFY_MODES.includes(sslMode) || (iamAuth && !sslMode);

  if (verify && !hasCa && debug) {
    console.warn(
      'sslMode set to verify-ca/verify-full but no sslrootcert provided; using system CA store'
    );
  }

  return { ...material, rejectUnauthorized: verify };
}

/**
 * True when the connection leaves Postgres TLS negotiable - no mode, `prefer`
 * or `allow` - which pgjdbc (and so DBeaver) treats as "try TLS first".
 * IAM auth is excluded because it already requires TLS.
 */
export function postgresSslNegotiable(connection: DatabaseConnection, iamAuth = false): boolean {
  return !iamAuth && ['', 'prefer', 'allow'].includes(postgresSslMode(connection));
}

/** pg's error when the server answers an SSLRequest with `N`. */
export function isSslUnsupportedError(error: unknown): boolean {
  return error instanceof Error && /server does not support SSL/i.test(error.message);
}

/**
 * Give a pg pool libpq's `prefer` behaviour: every new connection starts with
 * encryption (unverified, as `prefer` is), and when the server says it has no
 * TLS that one attempt is retried in plaintext. The pool keeps its TLS
 * options, so the next physical connection tries TLS again.
 *
 * pg cannot fall back within one connection the way libpq does, so the retry
 * is a fresh connection. pg-pool builds a new client synchronously inside
 * `connect()` from `pool.options`, so swapping `ssl` around that call scopes
 * the plaintext to the retry; a retry that has to wait for a free slot is
 * served by an idle client or a TLS attempt instead. Only the promise form of
 * `connect()` is wrapped; that is the only one this codebase uses.
 */
export function withPostgresSslFallback<
  P extends { options: { ssl?: unknown }; connect: (...args: any[]) => any },
>(pool: P, onFallback?: () => void): P {
  const connect = pool.connect.bind(pool);
  pool.connect = ((...args: unknown[]) => {
    if (args.length > 0) return connect(...args);
    return (connect() as Promise<unknown>).catch((error: unknown) => {
      const ssl = pool.options.ssl;
      if (!ssl || !isSslUnsupportedError(error)) throw error;
      onFallback?.();
      pool.options.ssl = false;
      try {
        return connect();
      } finally {
        pool.options.ssl = ssl;
      }
    });
  }) as P['connect'];
  return pool;
}

/**
 * Build the `ssl` option for a `mysql2` connection or pool.
 *
 * MySQL's REQUIRED encrypts without validating the chain; only the VERIFY_*
 * modes authenticate the server certificate. Managed engines such as RDS
 * present certificates signed by their own CA, which is absent from the system
 * trust store, so verifying by default would break them.
 */
export function resolveMysqlSsl(
  connection: DatabaseConnection,
  iamAuth = false
): Record<string, unknown> | undefined {
  const sslMode = mysqlSslMode(connection);

  if (MYSQL_DISABLE_MODES.includes(sslMode)) {
    if (iamAuth)
      throw new Error('IAM authentication requires TLS; remove the disabled SSL setting');
    return undefined;
  }

  if (!MYSQL_REQUIRE_MODES.includes(sslMode) && !iamAuth) {
    return undefined;
  }

  const paths = mysqlSslPaths(connection);
  const material = buildSslMaterial(paths.ca, paths.cert, paths.key);

  const hasCa = typeof material.ca === 'string' && material.ca.length > 0;

  return {
    ...material,
    rejectUnauthorized: MYSQL_VERIFY_MODES.includes(sslMode) || hasCa || (iamAuth && !sslMode),
    ...((iamAuth && !sslMode) ||
    ['verify-full', 'verify_identity'].includes(sslMode) ||
    (hasCa && !['verify-ca', 'verify_ca'].includes(sslMode))
      ? { verifyIdentity: true }
      : {}),
  };
}
