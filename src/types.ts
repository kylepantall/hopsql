import type { AccessRule } from './policy/access.js';
import type { ExportCompression } from './runtime/compression.js';
export interface DatabaseConnection {
  id: string;
  /** Original configured identity; an override's id additionally includes its database. */
  baseId?: string;
  name: string;
  accessRules?: AccessRule[];
  limits?: { maxRows?: number; maxBytes?: number; timeoutMs?: number; poolMax?: number };
  /**
   * Driver id normalized to a dialect the native routing can dispatch on.
   * Custom drivers may use an opaque id (e.g. a UUID), in which case this is
   * resolved from the connection's `provider` or JDBC URL sub-protocol.
   */
  driver: string;
  /** Driver id exactly as configured in the workspace, for display and errors. */
  driverId?: string;
  /** Workspace `provider` id, e.g. "postgresql" or "mysql". */
  provider?: string;
  url: string;
  user?: string;
  host?: string;
  port?: number;
  database?: string;
  description?: string;
  connected?: boolean;
  readonly?: boolean;
  /** Writes need the user's approval in the client, one call at a time. */
  askBeforeWrite?: boolean;
  /**
   * Access was set in the managed overrides file (`hopsql manage` / `hopsql
   * access`), which wins over a HOPSQL_READ_ONLY=true server ceiling.
   */
  accessManaged?: boolean;
  folder?: string;
  properties?: Record<string, string>;
  /** Populated when the workspace routes this connection through an SSH tunnel. */
  sshTunnel?: SshTunnelConfig;
  /** AWS SSM hop declared in hopsql's own config; DBeaver has no fields for it. */
  ssm?: SsmConfig;
  /** Secrets Manager secret holding the username and password. */
  awsSecret?: AwsSecretConfig;
  /** A VPN brought up before the connection is dialled. */
  vpn?: VpnConfig;
}

/**
 * A VPN the connection needs up. hopsql drives the user's own VPN client:
 * `openvpn-connect` uses a profile imported into OpenVPN Connect, `command`
 * runs argv the user supplies for any other client (never through a shell).
 */
export type VpnConfig = (
  | { provider: 'openvpn-connect'; /** Profile id or name in OpenVPN Connect. */ profile: string }
  | {
      /**
       * OpenVPN in a local Docker container: only hopsql's connections use it,
       * through the container's SOCKS proxy. Set exactly one of `config` (an
       * .ovpn file) or `profile` (an OpenVPN Connect profile id or name).
       */
      provider: 'docker';
      config?: string;
      profile?: string;
    }
  | {
      /**
       * A vpnhop profile: vpnhop runs the tunnel and returns a loopback SOCKS
       * proxy (`vpnhop proxy <profile> --json`) that hopsql dials through, as
       * with `docker`. hopsql never stops vpnhop tunnels; their lease expires.
       */
      provider: 'vpnhop';
      profile: string;
    }
  | {
      provider: 'command';
      up: string[];
      down?: string[];
      /** Exit status 0 means the VPN is up; replaces the reachability probe. */
      check?: string[];
    }
) & {
  /** How long to wait for the connection's first hop to become reachable. */
  connectTimeoutMs?: number;
  /** Take the VPN down when hopsql exits, if hopsql brought it up. Default true. Not for vpnhop. */
  disconnectOnExit?: boolean;
};

/**
 * An AWS Systems Manager Session Manager hop.
 *
 * `ssh` carries the first SSH hop over an SSM session (OpenSSH's
 * `ProxyCommand aws ssm start-session ... AWS-StartSSHSession`). `port-forward`
 * replaces SSH entirely with `AWS-StartPortForwardingSessionToRemoteHost`.
 */
export interface SsmConfig {
  /** Instance or managed node id. Either this or `targetName` is set. */
  target?: string;
  /** `Name` tag of a running instance, looked up on every (re)connect. */
  targetName?: string;
  mode: 'ssh' | 'port-forward';
  region?: string;
  profile?: string;
  /** Port-forward destination as seen from the instance; defaults to the connection's. */
  remoteHost?: string;
  remotePort?: number;
}

/** An SSM hop whose target has been resolved to an instance id. */
export type ResolvedSsmConfig = SsmConfig & { target: string };

/**
 * A Secrets Manager secret in the RDS shape (`username`, `password`). Region
 * and profile default to the connection's SSM hop.
 */
export interface AwsSecretConfig {
  secretId: string;
  region?: string;
  profile?: string;
}

/** How a connection takes writes: refused, approved per call by the user, or allowed. */
export type WriteAccess = 'read-only' | 'ask' | 'writable';
export const WRITE_ACCESS_MODES: readonly WriteAccess[] = ['read-only', 'ask', 'writable'];

/**
 * Changes to the SSH route DBeaver records, merged onto `sshTunnel`. Carries
 * addresses and users only: authentication still comes from DBeaver or the
 * SSH agent.
 */
export interface SshOverride {
  /** `false` drops the tunnel and dials the database host directly. */
  enabled?: boolean;
  /** Replaces the final SSH host (the one that forwards to the database). */
  host?: string;
  port?: number;
  user?: string;
  /** Replaces DBeaver's bastions, outermost first; `[]` dials the final host directly. */
  jumpHosts?: SshHopOverride[];
}

export interface SshHopOverride {
  host: string;
  port?: number;
  user?: string;
}

/** Per-connection settings the config file layers onto discovered connections. */
export interface ConnectionOverride {
  ssm?: SsmConfig;
  ssh?: SshOverride;
  awsSecret?: AwsSecretConfig;
  vpn?: VpnConfig;
  /** Replaces the connection's own read-only flag. Older form of `access`. */
  readOnly?: boolean;
  /** Replaces the connection's own read-only flag; `ask` approves each write. */
  access?: WriteAccess;
}

/**
 * An SSH tunnel declared by a connection's `handlers.ssh_tunnel` block.
 *
 * The connection's own host/port describe the database *as seen from this SSH
 * server*, which is why they are frequently `localhost`.
 */
export interface SshTunnelConfig {
  enabled: boolean;
  host: string;
  port: number;
  user?: string;
  /** AGENT | PASSWORD | PUBLIC_KEY; inferred from the material when absent. */
  authType?: string;
  privateKeyPath?: string;
  passphrase?: string;
  password?: string;
  connectTimeoutMs?: number;
  /**
   * Bastions DBeaver hops through before reaching `host`, outermost first.
   * Each one is reached through the previous one's forward.
   */
  jumpHosts?: SshTunnelConfig[];
}

export interface QueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  /** Null when the execution API cannot report affected rows. */
  affectedRows?: number | null;
  executionTime: number;
  truncated?: boolean;
  limitReason?: 'rows' | 'bytes';
  error?: string;
}

export interface SchemaInfo {
  notes?: string[];
  physicalKeys?: Record<string, string>;
  partial?: boolean;
  tableName: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  length?: number;
  precision?: number;
  scale?: number;
}

export interface IndexInfo {
  primary?: boolean;
  definition?: string;
  predicate?: string;
  valid?: boolean;
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
}

export interface ConstraintInfo {
  definition?: string;
  nameIsGenerated?: boolean;
  name: string;
  type: 'PRIMARY_KEY' | 'FOREIGN_KEY' | 'UNIQUE' | 'CHECK';
  columns: string[];
  referencedTable?: string;
  referencedColumns?: string[];
}

export interface ExportOptions {
  format: 'csv' | 'json' | 'xml' | 'excel' | 'sql';
  includeHeaders: boolean;
  delimiter?: string;
  encoding?: string;
  maxRows?: number;
}

export interface WorkspaceConfig {
  workspacePath?: string;
  executablePath?: string;
  timeout?: number;
  debug?: boolean;
  /**
   * Name of the DB client project/workspace folder to read connections from
   * (e.g. a custom-named DBeaver project instead of the default "General").
   */
  projectName?: string;
}

export interface ConnectionTest {
  connectionId: string;
  success: boolean;
  error?: string;
  responseTime: number;
  databaseVersion?: string;
}

export interface DatabaseStats {
  totalSizeBytes?: string | null;
  sizeScope?: string;
  sizeComplete?: boolean;
  estimated?: boolean;
  notes?: string[];
  connectionId: string;
  tableCount: number;
  totalSize: string;
  connectionTime: number;
  serverVersion: string;
  uptime?: string;
}

export interface BusinessInsight {
  id: number;
  insight: string;
  created_at: string;
  connection?: string;
  tags?: string[];
}

export interface TableResource {
  connectionId: string;
  tableName: string;
  schema?: string;
  uri: string;
}

// Transaction types
export interface Transaction {
  id: string;
  connectionId: string;
  startedAt: Date;
  status: 'active' | 'committed' | 'rolled_back';
}

export interface TransactionResult {
  transactionId: string;
  status: 'started' | 'committed' | 'rolled_back';
  message: string;
}

// Connection pool types
export interface PoolConfig {
  min: number;
  max: number;
  idleTimeoutMs: number;
  acquireTimeoutMs: number;
}

export interface PoolStats {
  connectionId: string;
  totalConnections: number;
  idleConnections: number;
  activeConnections: number;
  waitingRequests: number;
}

// Explain/Query plan types
export interface ExplainResult {
  query: string;
  plan: QueryPlanNode[];
  executionTime?: number;
  planningTime?: number;
  totalCost?: number;
  format: 'text' | 'json';
}

export interface QueryPlanNode {
  operation: string;
  object?: string;
  cost?: number;
  rows?: number;
  width?: number;
  actualTime?: number;
  actualRows?: number;
  children?: QueryPlanNode[];
  details?: Record<string, unknown>;
}

// Schema diff types
export interface SchemaDiff {
  sourceConnection: string;
  targetConnection: string;
  differences: TableDiff[];
  summary: DiffSummary;
}

export interface TableDiff {
  tableName: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  columnDiffs?: ColumnDiff[];
  indexDiffs?: IndexDiff[];
  constraintDiffs?: {
    constraintName: string;
    status: 'added' | 'removed' | 'modified';
    changes?: string[];
  }[];
  physicalKeyDiffs?: { kind: string; before?: string; after?: string }[];
}

export interface ColumnDiff {
  columnName: string;
  status: 'added' | 'removed' | 'modified';
  sourceType?: string;
  targetType?: string;
  changes?: string[];
}

export interface IndexDiff {
  indexName: string;
  status: 'added' | 'removed' | 'modified';
  changes?: string[];
}

export interface DiffSummary {
  tablesAdded: number;
  tablesRemoved: number;
  tablesModified: number;
  totalDifferences: number;
}

/** TLS settings for a database command line client: a mode plus certificate file paths. */
export interface CliSslSettings {
  mode: string;
  ca?: string;
  cert?: string;
  key?: string;
}

/** Caps applied while an export streams to its artifact file. */
export interface ExportLimits {
  maxRows: number;
  /** Uncompressed output bytes. */
  maxBytes: number;
  timeoutMs: number;
}

export type ExportLimitReason = 'rows' | 'bytes';

/** Options shared by the `dump_table` and `dump_database` tools. */
export interface DumpOptions {
  tables?: string[];
  schemaOnly?: boolean;
  dataOnly?: boolean;
}

export type DumpFlavor = 'postgres' | 'mysql' | 'mariadb';

/** A resolved dump client binary and the option dialect it speaks. */
export interface DumpBinary {
  path: string;
  flavor: DumpFlavor;
}

/** A shell-free dump invocation; secrets live only in `env` or `defaultsFile`. */
export interface DumpCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Arguments before the client's own options, e.g. a script run by an interpreter. */
  prefixArgs?: string[];
  /** Contents of a private MySQL option file, passed first as `--defaults-file`. */
  defaultsFile?: string;
  /** False when TLS through a tunnel checks the CA but not the server's hostname. */
  tlsHostnameVerified?: false;
}

export type DumpErrorCode =
  | 'DUMP_TOOL_MISSING'
  | 'DUMP_UNSUPPORTED_DRIVER'
  | 'DUMP_INVALID_OPTIONS'
  | 'DUMP_TIMEOUT'
  | 'DUMP_OUTPUT_LIMIT'
  | 'DUMP_FAILED';

/** Streaming export and dump budgets, read from `HOPSQL_EXPORT_*` / `HOPSQL_DUMP_*`. */
export interface ExportSettings {
  /** Total bytes the private artifact store may hold. */
  artifactQuotaBytes: number;
  export: ExportLimits;
  /** `fileMaxBytes` caps a dump saved straight to the dump folder. */
  dump: { maxBytes: number; timeoutMs: number; fileMaxBytes: number };
}

/** Machine-wide settings `hopsql manage` keeps beside the connection overrides. */
export interface ManagedSettings {
  /** Absolute paths of pinned dump clients. */
  tools?: { pgDump?: string; mysqldump?: string };
  /** Where `saveToFile` dumps are written. */
  dumpDirectory?: string;
}

/** Where and as whom a dump client connects; secrets never reach argv. */
export interface DumpTarget {
  /** Endpoint to dial: the SSH tunnel's loopback forward when tunneled. */
  host: string;
  port: number;
  tunneled: boolean;
  /** Original database hostname, for TLS identity checks through a tunnel. */
  serverName?: string;
  database?: string;
  user: string;
  password?: string;
  ssl?: CliSslSettings;
  /** RDS IAM tokens need MySQL's cleartext authentication plugin. */
  cleartextAuth?: boolean;
}

/** A validated `export_data` request, as handed to the streaming path. */
export interface ExportRequest {
  format: 'csv' | 'json';
  compression: ExportCompression;
  includeHeaders: boolean;
  requestedRows: number;
}
