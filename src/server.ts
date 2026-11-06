import { quoteQualifiedIdentifier } from './metadata/identifiers.js';
import {
  privateConnectionId,
  publicConnectionId,
  registerConnectionPrivacy,
  registerPrivateValue,
  sanitizeDiagnostic,
  safeDatabaseVersion,
} from './privacy.js';
import {
  compressText,
  compressionExtension,
  type ExportCompression,
} from './runtime/compression.js';
import { PrivateNotes } from './runtime/notes.js';
import { ResultArtifacts, type ArtifactSource, type ArtifactScope } from './runtime/artifacts.js';
import { connectionFingerprint } from './runtime/connection-identity.js';
import {
  ExportEncoder,
  ExportWriter,
  streamMysql,
  streamPostgres,
  withCompression,
} from './runtime/export-stream.js';
import {
  DumpError,
  buildDumpCommand,
  dumpFlavorFor,
  resolveDumpBinary,
  createDumpFile,
  dumpDirectory,
  resolveDumpTarget,
  runDump,
} from './runtime/dump.js';
import { sqlDialect } from './policy/analyzer.js';
import { acquireLease } from './runtime/lease.js';
import type { Pool as PgPool } from 'pg';
import type { Pool as MySqlPool } from 'mysql2/promise';
import { AccessPolicy } from './policy/access.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  booleanSetting,
  connectionStreamLimits,
  exportSettings,
  integerSetting,
} from './runtime-config.js';
import { validateToolArguments } from './policy/arguments.js';
import { validateStatement } from './policy/sql.js';
import { checkForUpdate, getUpdateStatus, installLocation, runUpdate } from './update-check.js';
import { RECONNECT_HINT, installedEntry, isStale, refreshServers } from './refresh.js';
import { WorkspaceConfigParser } from './config-parser.js';
import {
  loadManagedOverrides,
  managedOverridesPath,
  overrideAccess,
} from './connections-config.js';
import { WorkspaceClient } from './workspace-client.js';
import type {
  BusinessInsight,
  DatabaseConnection,
  DumpOptions,
  ExportRequest,
  SchemaDiff,
  QueryResult,
} from './types.js';
import {
  validateQuery,
  enforceReadOnly,
  sanitizeConnectionId,
  parseConnectionId,
  formatError,
  convertToCSV,
  redactConnection,
  resolveQueryText,
} from './utils.js';
import { ConnectionPoolManager } from './pools/index.js';
import { sshTunnelManager, type HostKeyQuestion } from './net/ssh-tunnel.js';
import { vpnManager } from './net/vpn.js';
import { TransactionManager } from './managers/index.js';
import {
  describeScriptForApproval,
  MAX_APPROVAL_CHARS,
  scriptStatements,
} from './runtime/script.js';
import { buildExplainQuery, parseExplainOutput } from './utils/query-analyzer.js';
import { compareSchemas, comparableSchema, generateMigrationScript } from './utils/schema-diff.js';
import fs from 'fs';
import { finished } from 'node:stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
);
const VERSION = packageJson.version;

const SQL_FILE_PROPERTY = {
  type: 'string',
  description:
    'Instead of query: absolute path to a local .sql/.psql/.pgsql/.mysql/.ddl/.dml file (max 1 MiB) holding one statement. Relative paths resolve against the server working directory',
};

// Tool categories for filtering
const WRITE_TOOLS = [
  'write_query',
  'run_script',
  'create_table',
  'alter_table',
  'drop_table',
  'begin_transaction',
  'commit_transaction',
  'rollback_transaction',
  'execute_in_transaction',
];

const DATABASE_TOOLS = new Set([
  'write_query',
  'run_script',
  'create_table',
  'alter_table',
  'drop_table',
  'begin_transaction',
  'execute_query',
  'export_data',
  'dump_table',
  'dump_database',
  'explain_query',
  'list_tables',
  'get_table_schema',
  'get_database_stats',
  'get_table_stats',
  'test_connection',
  'get_pool_stats',
]);

// Limits
const MAX_INSIGHTS = 1000;
const STALE_TRANSACTION_CHECK_MS = 5 * 60 * 1000; // 5 minutes
const MAX_QUERY_ROWS = 100000;
const MAX_EXPORT_ROWS = 1000000;
const DEFAULT_QUERY_ROWS = 1000;
const DEFAULT_EXPORT_ROWS = 10000;

export class HopsqlMCPServer {
  private exportSettings = exportSettings();
  private artifacts = new ResultArtifacts(undefined, this.exportSettings.artifactQuotaBytes);
  private accessPolicy = new AccessPolicy();
  private server: Server;
  private configParser: WorkspaceConfigParser;
  private workspaceClient: WorkspaceClient;
  private poolManager: ConnectionPoolManager;
  private transactionManager: TransactionManager;
  private debug: boolean;
  private insights: BusinessInsight[] = [];
  private notes: PrivateNotes;
  private notesScope: string;
  private readOnly: boolean;
  private disabledTools: string[];
  private allowedConnections: Set<string> | null; // null = allow all
  private staleCleanupInterval: ReturnType<typeof setInterval> | null = null;
  /** Run a tool with the same validation and policy as an MCP call; the CLI uses it too. */
  callTool!: (name: string, args: unknown) => Promise<any>;

  constructor() {
    this.debug = process.env.HOPSQL_DEBUG === 'true';
    this.readOnly = booleanSetting(process.env.HOPSQL_READ_ONLY, 'HOPSQL_READ_ONLY', true);
    this.disabledTools = (process.env.HOPSQL_DISABLED_TOOLS || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    // Parse allowed connections whitelist
    const allowedRaw = process.env.HOPSQL_ALLOWED_CONNECTIONS || '';
    const allowedList = allowedRaw
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    this.allowedConnections = allowedList.length > 0 ? new Set(allowedList) : null;

    this.server = new Server(
      {
        name: 'hopsql',
        version: VERSION,
      },
      {
        capabilities: {
          // Write tools come and go as `hopsql access` changes connections.
          tools: { listChanged: true },
          resources: {},
        },
      }
    );

    this.configParser = new WorkspaceConfigParser({
      debug: this.debug,
      timeout: integerSetting(process.env.HOPSQL_TIMEOUT, 'HOPSQL_TIMEOUT', 30000),
      executablePath: process.env.HOPSQL_CLI_PATH,
      workspacePath: process.env.HOPSQL_WORKSPACE,
      projectName: process.env.HOPSQL_PROJECT,
    });

    for (const value of [
      process.env.HOPSQL_CONFIG_FILE,
      process.env.HOPSQL_WORKSPACE,
      process.env.HOPSQL_POLICY_FILE,
      process.env.HOPSQL_CLI_PATH,
    ])
      registerPrivateValue(value);

    this.notesScope = this.currentNotesScope();
    this.notes = new PrivateNotes(this.notesScope);

    // Initialize connection pool and transaction manager
    sshTunnelManager.setDebug(this.debug);

    this.poolManager = new ConnectionPoolManager(
      {
        min: integerSetting(process.env.HOPSQL_POOL_MIN, 'HOPSQL_POOL_MIN', 0, 0, 32),
        max: integerSetting(process.env.HOPSQL_POOL_MAX, 'HOPSQL_POOL_MAX', 4, 1, 32),
        idleTimeoutMs: integerSetting(
          process.env.HOPSQL_POOL_IDLE_TIMEOUT,
          'HOPSQL_POOL_IDLE_TIMEOUT',
          30000,
          1,
          300000
        ),
        acquireTimeoutMs: integerSetting(
          process.env.HOPSQL_POOL_ACQUIRE_TIMEOUT,
          'HOPSQL_POOL_ACQUIRE_TIMEOUT',
          10000,
          1,
          300000
        ),
      },
      this.debug,
      integerSetting(process.env.HOPSQL_TIMEOUT, 'HOPSQL_TIMEOUT', 30000)
    );
    this.workspaceClient = new WorkspaceClient(
      process.env.HOPSQL_CLI_PATH,
      integerSetting(process.env.HOPSQL_TIMEOUT, 'HOPSQL_TIMEOUT', 30000),
      this.debug,
      process.env.HOPSQL_WORKSPACE || this.configParser.getWorkspacePath(),
      this.poolManager
    );

    this.transactionManager = new TransactionManager(
      this.poolManager,
      this.debug,
      (id) => this.getConnection(id),
      integerSetting(process.env.HOPSQL_TIMEOUT, 'HOPSQL_TIMEOUT', 30000)
    );

    this.loadInsights();
    this.setupResourceHandlers();
    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private log(message: string, level: 'info' | 'error' | 'debug' = 'info') {
    if (level === 'debug' && !this.debug) return;

    message = sanitizeDiagnostic(message);
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

    if (level === 'error') {
      console.error(`${prefix} ${message}`);
    } else {
      console.error(`${prefix} ${message}`);
    }
  }

  private currentNotesScope(): string {
    return this.privateStateScope(this.configParser.stateRevision());
  }
  private currentArtifactScope(): string {
    return this.privateStateScope(this.configParser.sourceIdentity());
  }
  private privateStateScope(sourceRevision: string): string {
    return JSON.stringify([
      sourceRevision,
      this.accessPolicy.revision(),
      [...(this.allowedConnections ?? [])].sort(),
      this.allowedConnections !== null,
      this.readOnly,
      this.disabledTools,
      typeof process.getuid === 'function' ? process.getuid() : null,
    ]);
  }
  private refreshNotes() {
    const scope = this.currentNotesScope();
    if (scope !== this.notesScope) {
      this.notesScope = scope;
      this.notes = new PrivateNotes(scope);
      this.insights = this.notes.load();
    }
  }
  private loadInsights() {
    try {
      this.insights = this.notes.load();
    } catch (error) {
      this.log(`Failed to load insights: ${error}`, 'debug');
      this.insights = [];
    }
  }

  private saveInsights() {
    try {
      // Cap insights to prevent unbounded growth
      if (this.insights.length > MAX_INSIGHTS) {
        this.insights = this.insights.slice(-MAX_INSIGHTS);
      }
      this.insights = this.notes.save(this.insights);
    } catch (error) {
      this.log(`Failed to save insights: ${error}`, 'error');
    }
  }

  /**
   * Check if a connection is allowed by the whitelist.
   * Matches against both connection ID and name.
   *
   * A database-override lookup ("<id>/<database>") produces a synthetic id, so
   * match on the base id too - otherwise every override would be rejected as
   * an unknown connection whenever a whitelist is configured. Whitelisting a
   * connection therefore grants the databases reachable with its credentials,
   * not just its default one; list explicit "<id>/<database>" entries to pin it.
   */
  private isConnectionAllowed(conn: { id: string; name: string }): boolean {
    if (!this.allowedConnections) return true; // No whitelist = allow all
    if (this.allowedConnections.has(conn.id) || this.allowedConnections.has(conn.name)) {
      return true;
    }

    if ('baseId' in conn && typeof conn.baseId === 'string')
      return conn.id !== conn.baseId && this.allowedConnections.has(conn.baseId);

    const { baseId, databaseOverride } = parseConnectionId(conn.id);
    if (databaseOverride === null) return false;

    // The exact "<id>/<database>" entry was already checked above, so listing
    // only pinned entries for a connection - and no bare one - denies every
    // other database on it, which is what writing them that way asks for.
    return this.allowedConnections.has(baseId);
  }

  /**
   * Get all connections, filtered by the whitelist.
   */
  private async getFilteredConnections(): Promise<DatabaseConnection[]> {
    const connections = await this.configParser.parseConnections();
    connections.forEach(registerConnectionPrivacy);
    if (!this.allowedConnections)
      return connections.filter((c) => this.accessPolicy.allowsDatabase(c));
    return connections.filter(
      (conn) => this.isConnectionAllowed(conn) && this.accessPolicy.allowsDatabase(conn)
    );
  }

  /**
   * Get a single connection by ID/name, respecting the whitelist.
   */
  private async getConnection(
    connectionId: string,
    database?: string
  ): Promise<DatabaseConnection | null> {
    if (
      connectionId.startsWith('connection-') &&
      privateConnectionId(connectionId) === connectionId
    )
      (await this.configParser.parseConnections()).forEach(publicConnectionId);
    const connection = await this.configParser.getConnection(
      privateConnectionId(connectionId),
      database
    );
    if (connection) registerConnectionPrivacy(connection);
    if (!connection) return null;
    if (!this.isConnectionAllowed(connection)) return null;
    this.accessPolicy.assertConnection(connection);
    return connection;
  }

  private setupErrorHandling() {
    process.on('uncaughtException', (error) => {
      this.log(`Uncaught exception: ${error.message}`, 'error');
      if (this.debug) {
        this.log(error.stack || '', 'debug');
      }
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.log(`Unhandled rejection at: ${promise}, reason: ${reason}`, 'error');
      if (this.debug) {
        this.log(String(reason), 'debug');
      }
    });

    // Graceful shutdown: roll back active transactions, then close pools
    const shutdown = async () => {
      this.log('Shutting down gracefully...');
      await this.artifacts.close();
      try {
        const rolledBack = await this.transactionManager.rollbackAll();
        if (rolledBack > 0) {
          this.log(`Rolled back ${rolledBack} active transaction(s) during shutdown`);
        }
      } catch (error) {
        this.log(`Error rolling back transactions during shutdown: ${formatError(error)}`, 'error');
      }
      try {
        await this.poolManager.closeAllPools();
      } catch (error) {
        this.log(`Error closing pools during shutdown: ${formatError(error)}`, 'error');
      }
      try {
        // After the pools, so nothing is still using a forward when it closes.
        await sshTunnelManager.closeAll();
      } catch (error) {
        this.log(`Error closing SSH tunnels during shutdown: ${formatError(error)}`, 'error');
      }
      // Last: the tunnels above may have run through it. Recycling keeps it up.
      await vpnManager.disconnectAll();
      if (this.staleCleanupInterval) {
        clearInterval(this.staleCleanupInterval);
      }
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    // `hopsql refresh` and the refresh tool recycle current servers in place.
    if (process.platform !== 'win32')
      process.on('SIGHUP', () => {
        this.recycle().catch((error) => this.log(`Recycle failed: ${formatError(error)}`, 'error'));
      });
  }

  /**
   * Drop pooled connections, tunnels and cached workspace connections so the
   * next call reconnects with current configuration and credentials. Skipped
   * while transactions are open, since closing their pools would abort them.
   */
  private async recycle(): Promise<{ recycled: boolean; openTransactions: number }> {
    const openTransactions = this.transactionManager.getActiveTransactions().length;
    if (openTransactions > 0) return { recycled: false, openTransactions };
    await this.poolManager.closeAllPools();
    // After the pools, so nothing is still using a forward when it closes.
    await sshTunnelManager.closeAll();
    this.configParser.clearCache();
    this.refreshNotes();
    this.log('Recycled pools, tunnels and caches');
    return { recycled: true, openTransactions };
  }

  /** The `refresh` tool: the same as `hopsql refresh`, then this server recycles too. */
  private async handleRefresh() {
    const others = refreshServers();
    const self = await this.recycle();
    let installedVersion: string | null = null;
    let outdated = false;
    try {
      installedVersion = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
      ).version;
      const startedAt = new Date(Date.now() - process.uptime() * 1000);
      outdated = isStale({ pid: process.pid, startedAt }, installedEntry().builtAt);
    } catch {
      /* Not an installed layout; nothing newer to compare with. */
    }
    const restartRequired = outdated || (installedVersion !== null && installedVersion !== VERSION);
    let connections: number | null = null;
    let error: string | undefined;
    try {
      connections = (await this.getFilteredConnections()).length;
    } catch (cause) {
      error = formatError(cause);
    }
    return {
      runningVersion: VERSION,
      installedVersion,
      restartRequired,
      ...(restartRequired ? { restart: RECONNECT_HINT } : {}),
      recycled: self.recycled,
      openTransactions: self.openTransactions,
      otherServers: others,
      connections,
      ...(error ? { error } : {}),
    };
  }

  private setupResourceHandlers() {
    // List all available database resources (table schemas)
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      try {
        if (
          this.disabledTools.includes('list_connections') ||
          this.disabledTools.includes('list_tables')
        )
          return { resources: [] };
        const connections = await this.getFilteredConnections();
        const resources = connections.map((connection) => ({
          uri: `hopsql:///connections/${encodeURIComponent(publicConnectionId(connection))}`,
          mimeType: 'application/json',
          name: sanitizeDiagnostic(connection.name),
          description: `${redactConnection(connection).driver} connection; browse tables on demand`,
        }));

        return { resources };
      } catch (error) {
        this.log(`Failed to list resources: ${error}`, 'error');
        return { resources: [] };
      }
    });

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: this.disabledTools.includes('get_table_schema')
        ? []
        : [
            {
              uriTemplate: 'hopsql:///connections/{connectionId}/tables/{tableName}/schema',
              name: 'Table schema',
              mimeType: 'application/json',
              description: 'Read a table schema after choosing a connection and an allowed table',
            },
          ],
    }));

    // Get schema information for a specific table
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      try {
        const uri = new URL(request.params.uri);
        if (uri.protocol !== 'hopsql:') throw new Error('Invalid resource URI');
        const parts = uri.pathname
          .split('/')
          .filter(Boolean)
          .map((p) => decodeURIComponent(p));
        if (
          parts[0] === 'connections' &&
          (parts.length === 2 || (parts.length === 3 && parts[2] === 'tables'))
        ) {
          const connection = await this.getConnection(parts[1]);
          if (!connection) throw new Error('Connection not found');
          if (parts.length === 2) {
            if (this.disabledTools.includes('get_connection_info'))
              throw new Error('Connection detail access is disabled');
            return {
              contents: [
                {
                  uri: `hopsql:///connections/${encodeURIComponent(publicConnectionId(connection))}`,
                  mimeType: 'application/json',
                  text: JSON.stringify({
                    ...this.connectionInfo(connection),
                    tablesUri: `hopsql:///connections/${encodeURIComponent(publicConnectionId(connection))}/tables`,
                  }),
                },
              ],
            };
          }
          if (this.disabledTools.includes('list_tables'))
            throw new Error('Table listing is disabled');
          const source = this.catalogSource(connection);
          const tables = await this.workspaceClient.listTables(connection, undefined, true);
          const result = tables.map((t) => ({
            ...t,
            schemaUri: `hopsql:///connections/${encodeURIComponent(publicConnectionId(connection))}/tables/${encodeURIComponent([t.table_schema, t.name].filter(Boolean).join('.'))}/schema`,
          }));
          const document = await this.presentDocument(result, source);
          return {
            contents: [
              {
                uri: `hopsql:///connections/${encodeURIComponent(publicConnectionId(connection))}/tables`,
                mimeType: 'application/json',
                text: document.content[0].text,
              },
            ],
          };
        }
        if (this.disabledTools.includes('get_table_schema'))
          throw new Error('Schema access is disabled');
        const modern =
          parts.length === 5 &&
          parts[0] === 'connections' &&
          parts[2] === 'tables' &&
          parts[4] === 'schema';
        const legacy = !!uri.hostname && parts.length === 2 && parts[1] === 'schema';
        if (!modern && !legacy) throw new Error('Invalid resource URI format');
        const connectionId = modern ? parts[1] : decodeURIComponent(uri.hostname);
        const tableName = modern ? parts[3] : parts[0];

        const connection = await this.getConnection(connectionId);
        if (!connection) {
          throw new Error(`Connection not found: ${connectionId}`);
        }

        const source = this.catalogSource(connection);
        const schema = await this.workspaceClient.getTableSchema(connection, tableName);
        const document = await this.presentDocument(schema, source);

        return {
          contents: [
            {
              uri: `hopsql:///connections/${encodeURIComponent(publicConnectionId(connection))}/tables/${encodeURIComponent(tableName)}/schema`,
              mimeType: 'application/json',
              text: document.content[0].text,
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Failed to read resource: ${formatError(error)}`
        );
      }
    });
  }

  private setupToolHandlers() {
    const tools: Tool[] = [
      {
        name: 'list_connections',
        description: 'List all available database connections',
        inputSchema: {
          type: 'object',
          properties: {
            includeDetails: {
              type: 'boolean',
              description: 'Include detailed connection information',
              default: false,
            },
          },
        },
      },
      {
        name: 'get_connection_info',
        description:
          'Get detailed information about a specific database connection. Credentials are never returned: to run a local tool (psql, mysql, migrations, scripts) against a writable PostgreSQL/MySQL/MariaDB connection, run `hopsql exec <connectionId> -- <command>` in a shell, which injects PG*/MYSQL_*/DATABASE_URL into that command only',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection',
            },
          },
          required: ['connectionId'],
        },
      },
      {
        name: 'execute_query',
        description: 'Execute a SQL query on a specific database connection (read-only queries)',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection to use',
            },
            query: {
              type: 'string',
              description: 'The SQL query to execute (SELECT statements only)',
            },
            file: SQL_FILE_PROPERTY,
            maxRows: {
              type: 'number',
              description: 'Maximum number of rows to return (default: 1000)',
              default: 1000,
            },
          },
          required: ['connectionId'],
        },
      },
      {
        name: 'write_query',
        description: 'Execute INSERT, UPDATE, or DELETE queries on a specific database connection',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection to use',
            },
            query: {
              type: 'string',
              description: 'The SQL query to execute (INSERT, UPDATE, DELETE)',
            },
            file: SQL_FILE_PROPERTY,
          },
          required: ['connectionId'],
        },
      },
      {
        name: 'run_script',
        description:
          'Run a multi-statement SQL script (a migration) in one transaction: every statement commits, or the first failure rolls them all back. A leading BEGIN and trailing COMMIT are optional. Supports DML, PostgreSQL DO blocks, and DDL on PostgreSQL and SQL Server (MySQL commits DDL implicitly, so it is refused there). Each statement passes the same access checks as execute_in_transaction; ask connections approve the whole script once',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection to use',
            },
            database: {
              type: 'string',
              description: 'Database to run against, if not the connection default',
            },
            script: { type: 'string', description: 'The SQL script text' },
            file: {
              type: 'string',
              description:
                'Instead of script: absolute path to a local .sql/.psql/.pgsql/.mysql/.ddl/.dml file (max 1 MiB). Relative paths resolve against the server working directory',
            },
          },
          required: ['connectionId'],
        },
      },
      {
        name: 'check_for_update',
        description:
          'Check GitHub for a newer Hopsql release. When one is available, offer the user to install it with update_hopsql or by running "hopsql update"',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'refresh',
        description:
          'Recycle Hopsql: drop pooled connections, tunnels and cached configuration so the next call reconnects with current settings and credentials; recycle other running Hopsql servers and stop ones older than the installed version. Call it when connections fail after a config or credential change or an update. If restartRequired is true, ask the user to reconnect the MCP server',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'update_hopsql',
        description:
          'Install the latest Hopsql release. The user confirms in the client before anything is downloaded; MCP clients need a restart afterwards',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'create_table',
        description: 'Create new tables in the database',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection',
            },
            query: {
              type: 'string',
              description: 'CREATE TABLE statement',
            },
          },
          required: ['connectionId', 'query'],
        },
      },
      {
        name: 'alter_table',
        description: 'Modify existing table schema (add columns, rename tables, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection',
            },
            query: {
              type: 'string',
              description: 'ALTER TABLE statement',
            },
          },
          required: ['connectionId', 'query'],
        },
      },
      {
        name: 'drop_table',
        description: 'Remove a table from the database with safety confirmation',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection',
            },
            tableName: {
              type: 'string',
              description: 'Name of the table to drop',
            },
            confirm: {
              type: 'boolean',
              description: 'Safety confirmation flag (must be true)',
            },
          },
          required: ['connectionId', 'tableName', 'confirm'],
        },
      },
      {
        name: 'get_table_schema',
        description: 'Get schema information for a specific table',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection',
            },
            tableName: {
              type: 'string',
              description: 'The name of the table to describe',
            },
            includeIndexes: {
              type: 'boolean',
              description: 'Include index information',
              default: true,
            },
          },
          required: ['connectionId', 'tableName'],
        },
      },
      {
        name: 'export_data',
        description: 'Export query results to various formats (CSV, JSON, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection',
            },
            query: {
              type: 'string',
              description: 'The SQL query to execute for export (SELECT only)',
            },
            format: {
              type: 'string',
              enum: ['csv', 'json'],
              description: 'Export format (csv or json)',
              default: 'csv',
            },
            compression: {
              type: 'string',
              enum: ['none', 'gzip', 'brotli', 'zstd'],
              default: 'none',
              description:
                'Optional download compression. Compressed exports return a read_export handle; concatenate decoded base64 chunks, then decompress.',
            },
            includeHeaders: {
              type: 'boolean',
              description: 'Include column headers in export',
              default: true,
            },
            maxRows: {
              type: 'number',
              description:
                'Maximum number of rows to export. PostgreSQL and MySQL/MariaDB stream to a file up to HOPSQL_EXPORT_MAX_ROWS; other engines are capped at 1000000',
              default: 10000,
            },
          },
          required: ['connectionId', 'query'],
        },
      },
      ...(['dump_table', 'dump_database'] as const).map((name): Tool => ({
        name,
        description:
          name === 'dump_table'
            ? 'Dump table DDL and/or data as SQL with pg_dump or mysqldump/mariadb-dump; returns a read_export handle'
            : 'Dump a whole database (or an include list of tables) as SQL with pg_dump or mysqldump/mariadb-dump; returns a read_export handle',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of a PostgreSQL or MySQL/MariaDB connection',
            },
            tables: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 1024 },
              ...(name === 'dump_table' ? { minItems: 1 } : {}),
              maxItems: 100,
              description:
                name === 'dump_table'
                  ? 'Tables to dump (schema.table on PostgreSQL)'
                  : 'Optional include list; omitted dumps every table',
            },
            schemaOnly: { type: 'boolean', default: false, description: 'DDL only, no rows' },
            dataOnly: { type: 'boolean', default: false, description: 'Rows only, no DDL' },
            compression: {
              type: 'string',
              enum: ['none', 'gzip', 'brotli', 'zstd'],
              default: 'none',
              description: 'Optional download compression applied while the dump streams',
            },
            saveToFile: {
              type: 'boolean',
              default: false,
              description:
                "Write the dump to a new file in the user's dump folder and return its path, instead of a read_export handle; use for large dumps",
            },
            fileName: {
              type: 'string',
              pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$',
              description:
                'With saveToFile: plain file name to create (default: <connection>-<timestamp>.sql)',
            },
          },
          required: name === 'dump_table' ? ['connectionId', 'tables'] : ['connectionId'],
        },
      })),
      {
        name: 'test_connection',
        description: 'Test connectivity to a database connection',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection to test',
            },
          },
          required: ['connectionId'],
        },
      },
      {
        name: 'get_database_stats',
        description: 'Get statistics and information about a database',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection',
            },
          },
          required: ['connectionId'],
        },
      },
      {
        name: 'list_tables',
        description: 'List all tables in a database',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection',
            },
            schema: {
              type: 'string',
              description: 'Specific schema to list tables from (optional)',
            },
            includeViews: {
              type: 'boolean',
              description: 'Include views in the results',
              default: false,
            },
          },
          required: ['connectionId'],
        },
      },
      {
        name: 'append_insight',
        description: 'Add a business insight or analysis note to the memo',
        inputSchema: {
          type: 'object',
          properties: {
            insight: {
              type: 'string',
              description: 'The business insight or analysis note to store',
            },
            connection: {
              type: 'string',
              description: 'Optional connection ID to associate with this insight',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional tags to categorize the insight',
            },
          },
          required: ['insight'],
        },
      },
      {
        name: 'list_insights',
        description: 'List all stored business insights and analysis notes',
        inputSchema: {
          type: 'object',
          properties: {
            connection: {
              type: 'string',
              description: 'Filter insights by connection ID (optional)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter insights by tags (optional)',
            },
          },
        },
      },
      // Transaction tools
      {
        name: 'begin_transaction',
        description: 'Start a new database transaction',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection',
            },
          },
          required: ['connectionId'],
        },
      },
      {
        name: 'commit_transaction',
        description: 'Commit an active transaction',
        inputSchema: {
          type: 'object',
          properties: {
            transactionId: {
              type: 'string',
              description: 'The transaction ID returned by begin_transaction',
            },
          },
          required: ['transactionId'],
        },
      },
      {
        name: 'rollback_transaction',
        description: 'Rollback an active transaction',
        inputSchema: {
          type: 'object',
          properties: {
            transactionId: {
              type: 'string',
              description: 'The transaction ID returned by begin_transaction',
            },
          },
          required: ['transactionId'],
        },
      },
      {
        name: 'execute_in_transaction',
        description: 'Execute a query within an active transaction',
        inputSchema: {
          type: 'object',
          properties: {
            transactionId: {
              type: 'string',
              description: 'The transaction ID returned by begin_transaction',
            },
            query: {
              type: 'string',
              description: 'The SQL query to execute',
            },
          },
          required: ['transactionId', 'query'],
        },
      },
      // Query analysis tools
      {
        name: 'explain_query',
        description: 'Get the execution plan for a SQL query',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection',
            },
            query: {
              type: 'string',
              description: 'The SQL query to analyze',
            },
            analyze: {
              type: 'boolean',
              description: 'Run EXPLAIN ANALYZE for actual execution stats',
              default: false,
            },
            format: {
              type: 'string',
              enum: ['text', 'json'],
              description: 'Output format for the execution plan',
              default: 'text',
            },
          },
          required: ['connectionId', 'query'],
        },
      },
      // Schema comparison tools
      {
        name: 'compare_schemas',
        description: 'Compare schemas between two database connections',
        inputSchema: {
          type: 'object',
          properties: {
            sourceConnectionId: {
              type: 'string',
              description: 'The source connection ID to compare from',
            },
            targetConnectionId: {
              type: 'string',
              description: 'The target connection ID to compare to',
            },
            includeMigrationScript: {
              type: 'boolean',
              description: 'Include a commented migration review outline; never executed',
              default: false,
            },
          },
          required: ['sourceConnectionId', 'targetConnectionId'],
        },
      },
      // Pool management tools
      {
        name: 'get_pool_stats',
        description: 'Get connection pool statistics for a connection',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: {
              type: 'string',
              description: 'The ID or name of the database connection',
            },
          },
          required: ['connectionId'],
        },
      },
    ];

    tools.push({
      name: 'list_databases',
      description:
        'List databases accessible through a saved PostgreSQL, MySQL/MariaDB, SQL Server, or ClickHouse connection',
      inputSchema: {
        type: 'object',
        properties: {
          connectionId: { type: 'string', description: 'Saved connection ID or name' },
        },
        required: ['connectionId'],
      },
    });
    tools.push({
      name: 'get_table_stats',
      description:
        'Get catalog row estimates and data/index storage without scanning the table; unavailable values are null',
      inputSchema: {
        type: 'object',
        properties: { connectionId: { type: 'string' }, tableName: { type: 'string' } },
        required: ['connectionId', 'tableName'],
      },
    });
    for (const name of ['read_result', 'read_result_cell', 'read_export']) {
      const properties: Record<string, any> = {
        resultId: { type: 'string', minLength: 32, maxLength: 32 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      };
      if (name === 'read_result') {
        properties.columnOffset = { type: 'integer', minimum: 0 };
        properties.columnLimit = { type: 'integer', minimum: 1, maximum: 100 };
      }
      if (name === 'read_result_cell') {
        properties.row = { type: 'integer', minimum: 0 };
        properties.column = { type: 'integer', minimum: 0 };
        delete properties.limit;
        properties.length = { type: 'integer', minimum: 1, maximum: 16000 };
      }
      if (name === 'read_export') {
        delete properties.limit;
        properties.length = { type: 'integer', minimum: 1, maximum: 48000 };
      }
      tools.push({
        name,
        description:
          name === 'read_result'
            ? 'Read a bounded page from a stored query result; follow nextOffset'
            : name === 'read_result_cell'
              ? 'Read a long cell in UTF-16 chunks; follow nextOffset. Concatenate text; parse JSON when encoding is json'
              : 'Read a stored export in base64 byte chunks; concatenate decoded bytes',
        inputSchema: {
          type: 'object',
          properties,
          required: name === 'read_result_cell' ? ['resultId', 'row', 'column'] : ['resultId'],
        },
      });
    }
    for (const tool of tools) {
      if (['append_insight', 'list_insights'].includes(tool.name)) {
        const props = tool.inputSchema.properties as Record<string, any>;
        if (props.insight) props.insight.maxLength = 16384;
        if (props.tags) props.tags.items.maxLength = 128;
      }
      tool.inputSchema.additionalProperties = false;
      const properties = tool.inputSchema.properties as Record<string, any>;
      if (properties?.maxRows) {
        properties.maxRows.type = 'integer';
        properties.maxRows.minimum = 1;
      }
      tool.annotations = {
        readOnlyHint:
          !WRITE_TOOLS.includes(tool.name) &&
          !['append_insight', 'update_hopsql', 'refresh'].includes(tool.name),
        destructiveHint: WRITE_TOOLS.includes(tool.name),
        openWorldHint: true,
      };
      if (DATABASE_TOOLS.has(tool.name)) {
        tool.inputSchema.properties = {
          ...tool.inputSchema.properties,
          database: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description:
              'Optional database on the same server; reuses saved credentials and settings',
          },
        };
      }
    }

    for (const name of this.disabledTools) {
      if (!tools.some((tool) => tool.name === name))
        throw new Error(`Unknown disabled tool: ${name}`);
    }

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Filter tools based on read-only mode and disabled tools
      let filteredTools = tools;

      // Remove write tools while no connection can take writes
      if (!this.writesPossible()) {
        filteredTools = filteredTools.filter((tool) => !WRITE_TOOLS.includes(tool.name));
      }

      // Remove explicitly disabled tools
      if (this.disabledTools.length > 0) {
        filteredTools = filteredTools.filter((tool) => !this.disabledTools.includes(tool.name));
      }

      return { tools: filteredTools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.callTool(request.params.name, request.params.arguments)
    );
    this.callTool = async (name, rawArgs) => {
      const definition = tools.find((tool) => tool.name === name);
      if (!definition) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      let args: Record<string, unknown>;
      try {
        args = validateToolArguments(definition, rawArgs);
      } catch (error) {
        throw new McpError(ErrorCode.InvalidParams, formatError(error));
      }

      // Block write tools if read-only mode is enabled
      if (WRITE_TOOLS.includes(name) && !this.writesPossible()) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tool '${name}' is disabled: every connection is read-only. Ask the user to run "hopsql access writable <connection>" (or "ask"); it applies without a restart.`
        );
      }

      // Block explicitly disabled tools
      if (this.disabledTools.includes(name)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tool '${name}' is disabled via HOPSQL_DISABLED_TOOLS configuration.`
        );
      }

      try {
        this.log(`Executing tool: ${name}`, 'debug');

        switch (name) {
          case 'list_databases':
            return await this.handleListDatabases(args as { connectionId: string });

          case 'get_table_stats': {
            const connection = await this.getConnection(
              args.connectionId as string,
              args.database as string | undefined
            );
            if (!connection) throw new Error('Connection not found');
            const source = this.catalogSource(connection);
            const result = await this.workspaceClient.getTableStats(
              connection,
              args.tableName as string
            );
            return this.presentDocument(result, source);
          }
          case 'read_result':
          case 'read_result_cell':
          case 'read_export': {
            const source = this.artifacts.source(args.resultId as string);
            const connections = await this.resultConnections(source);
            for (const [i, connection] of connections.entries()) {
              const access = source.scopes[i].access;
              if (access.kind === 'sql')
                await this.workspaceClient.assertQueryAccess(connection, access.query, false);
            }
            const result =
              name === 'read_result'
                ? await this.artifacts.page(
                    args.resultId as string,
                    args.offset as number | undefined,
                    args.limit as number | undefined,
                    args.columnOffset as number | undefined,
                    args.columnLimit as number | undefined
                  )
                : name === 'read_result_cell'
                  ? await this.artifacts.cell(
                      args.resultId as string,
                      args.row as number,
                      args.column as number,
                      args.offset as number | undefined,
                      args.length as number | undefined
                    )
                  : await this.artifacts.readExport(
                      args.resultId as string,
                      args.offset as number | undefined,
                      args.length as number | undefined
                    );
            await this.resultConnections(source);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          }
          case 'list_connections':
            return await this.handleListConnections(args as { includeDetails?: boolean });

          case 'get_connection_info':
            return await this.handleGetConnectionInfo(args as { connectionId: string });

          case 'execute_query':
            return await this.handleExecuteQuery({
              ...(args as { connectionId: string; database?: string; maxRows?: number }),
              query: this.queryArgument(args),
            });

          case 'write_query':
            return await this.handleWriteQuery({
              ...(args as { connectionId: string; database?: string }),
              query: this.queryArgument(args),
            });

          case 'run_script':
            return await this.handleRunScript(
              args as { connectionId: string; database?: string; script?: string; file?: string }
            );

          case 'check_for_update':
            return this.toolResult(await getUpdateStatus(VERSION, { maxAgeMs: 60 * 60 * 1000 }));

          case 'update_hopsql':
            return this.toolResult(await this.handleUpdate());

          case 'refresh':
            return this.toolResult(await this.handleRefresh());

          case 'create_table':
            return await this.handleCreateTable(
              args as {
                connectionId: string;
                query: string;
              }
            );

          case 'alter_table':
            return await this.handleAlterTable(
              args as {
                connectionId: string;
                query: string;
              }
            );

          case 'drop_table':
            return await this.handleDropTable(
              args as {
                connectionId: string;
                tableName: string;
                confirm: boolean;
              }
            );

          case 'get_table_schema':
            return await this.handleGetTableSchema(
              args as {
                connectionId: string;
                tableName: string;
                includeIndexes?: boolean;
              }
            );

          case 'export_data':
            return await this.handleExportData(
              args as {
                connectionId: string;
                query: string;
                format?: string;
                includeHeaders?: boolean;
                maxRows?: number;
              }
            );

          case 'dump_table':
          case 'dump_database':
            return await this.handleDump(
              name,
              args as unknown as DumpOptions & {
                connectionId: string;
                database?: string;
                compression?: ExportCompression;
                saveToFile?: boolean;
                fileName?: string;
              }
            );

          case 'test_connection':
            return await this.handleTestConnection(args as { connectionId: string });

          case 'get_database_stats':
            return await this.handleGetDatabaseStats(args as { connectionId: string });

          case 'list_tables':
            return await this.handleListTables(
              args as {
                connectionId: string;
                schema?: string;
                includeViews?: boolean;
              }
            );

          case 'append_insight':
            return await this.handleAppendInsight(
              args as {
                insight: string;
                connection?: string;
                tags?: string[];
              }
            );

          case 'list_insights':
            return await this.handleListInsights(
              args as {
                connection?: string;
                tags?: string[];
              }
            );

          // Transaction tools
          case 'begin_transaction':
            return await this.handleBeginTransaction(args as { connectionId: string });

          case 'commit_transaction':
            return await this.handleCommitTransaction(args as { transactionId: string });

          case 'rollback_transaction':
            return await this.handleRollbackTransaction(args as { transactionId: string });

          case 'execute_in_transaction':
            return await this.handleExecuteInTransaction(
              args as { transactionId: string; query: string }
            );

          // Query analysis tools
          case 'explain_query':
            return await this.handleExplainQuery(
              args as {
                connectionId: string;
                query: string;
                analyze?: boolean;
                format?: 'text' | 'json';
              }
            );

          // Schema comparison tools
          case 'compare_schemas':
            return await this.handleCompareSchemas(
              args as {
                sourceConnectionId: string;
                targetConnectionId: string;
                includeMigrationScript?: boolean;
              }
            );

          // Pool management tools
          case 'get_pool_stats':
            return await this.handleGetPoolStats(args as { connectionId: string });

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error: any) {
        this.log(`Tool execution failed: ${error}`, 'error');

        if (error instanceof McpError) {
          throw new McpError(error.code, sanitizeDiagnostic(error.message));
        }

        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${formatError(error)}`);
      }
    };
  }

  private async handleListDatabases(args: { connectionId: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }
    const source = this.catalogSource(connection);
    const databases = await this.workspaceClient.listDatabases(connection);
    return this.presentDocument(databases, source);
  }

  private async handleListConnections(_args: { includeDetails?: boolean }) {
    const connections = await this.getFilteredConnections();

    const result = connections.map((connection) => this.connectionInfo(connection));
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  }

  private connectionInfo(connection: DatabaseConnection) {
    return {
      ...redactConnection(connection),
      readonly: this.isReadOnly(connection),
      askBeforeWrite: !this.isReadOnly(connection) && connection.askBeforeWrite === true,
      limits: connection.limits,
      capabilities: this.workspaceClient.getCapabilities(connection),
    };
  }

  private async handleGetConnectionInfo(args: { connectionId: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const redacted = this.connectionInfo(connection);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(redacted, null, 2),
        },
      ],
    };
  }

  private async handleExecuteQuery(args: {
    connectionId: string;
    database?: string;
    query: string;
    maxRows?: number;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();
    const requestedRows = args.maxRows || DEFAULT_QUERY_ROWS;
    const maxRows = Math.min(Math.max(1, requestedRows), MAX_QUERY_ROWS);

    // Validate query
    const validationError = validateQuery(query);
    if (validationError) {
      throw new McpError(ErrorCode.InvalidParams, validationError);
    }

    // execute_query is for read-only operations - enforce SELECT-only
    const readOnlyError = enforceReadOnly(query);
    if (readOnlyError) {
      throw new McpError(ErrorCode.InvalidParams, readOnlyError);
    }

    const connection = await this.getConnection(connectionId, args.database);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const source = this.artifactSource(connection, query);
    const result = await this.workspaceClient.executeQuery(connection, query, {
      maxRows,
      readOnly: true,
    });

    return this.presentResult(result, source, {
      query,
      connection: sanitizeDiagnostic(connection.name),
    });
  }

  private artifactScope(
    connection: DatabaseConnection,
    access: ArtifactScope['access'],
    policyRevision = this.accessPolicy.revision()
  ): ArtifactScope {
    return {
      connectionId: connection.id,
      access,
      connectionFingerprint: connectionFingerprint(connection),
      policyRevision,
    };
  }
  private artifactSource(
    connection: DatabaseConnection,
    query: string,
    policyRevision?: string
  ): ArtifactSource {
    return {
      stateRevision: this.currentArtifactScope(),
      scopes: [this.artifactScope(connection, { kind: 'sql', query }, policyRevision)],
    };
  }
  private catalogSource(...connections: DatabaseConnection[]): ArtifactSource {
    return {
      stateRevision: this.currentArtifactScope(),
      scopes: connections.map((connection) => this.artifactScope(connection, { kind: 'catalog' })),
    };
  }
  private async resultConnections(source: ArtifactSource): Promise<DatabaseConnection[]> {
    if (source.stateRevision !== this.currentArtifactScope())
      throw new Error('Result connection or access policy changed; run the query again');
    const connections = [];
    for (const scope of source.scopes) {
      const connection = await this.getConnection(scope.connectionId, scope.database);
      if (!connection) throw new Error('Result connection is no longer accessible');
      if (
        connectionFingerprint(connection) !== scope.connectionFingerprint ||
        this.accessPolicy.revision() !== scope.policyRevision
      )
        throw new Error('Result connection or access policy changed; run the query again');
      connections.push(connection);
    }
    return connections;
  }
  private async presentDocument(value: object, source: ArtifactSource) {
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text);
    if (bytes <= 65536)
      return {
        content: [{ type: 'text' as const, text }],
        ...(!Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}),
      };
    if (bytes > 16 * 1024 * 1024)
      throw new Error(
        'Catalog document exceeds 16 MiB; narrow the request with schema or table policies'
      );
    if (this.disabledTools.includes('read_result_cell'))
      throw new Error(
        'Large catalog documents require read_result_cell; enable it or narrow the request'
      );
    const stored = await this.artifacts.save(
      { columns: ['document'], rows: [[value]], rowCount: 1, executionTime: 0 },
      source
    );
    const response = {
      kind: 'document',
      ...(await this.artifacts.page(stored.resultId, 0, 1)),
      readTool: 'read_result_cell',
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      structuredContent: response,
    };
  }

  private async presentResult(
    result: QueryResult,
    source: ArtifactSource,
    metadata: Record<string, unknown> = {}
  ) {
    let response: Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(result)) > 65536) {
      const stored = await this.artifacts.save(result, source);
      response = {
        ...metadata,
        executionTime: result.executionTime,
        ...(await this.artifacts.page(stored.resultId, 0, 25)),
      };
    } else response = { ...metadata, ...result, truncated: result.truncated === true };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      structuredContent: response,
    };
  }

  private async handleWriteQuery(args: { connectionId: string; database?: string; query: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();

    // Validate query type
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.startsWith('select')) {
      throw new McpError(ErrorCode.InvalidParams, 'Use execute_query for SELECT operations');
    }

    if (!(
      lowerQuery.startsWith('insert') ||
      lowerQuery.startsWith('update') ||
      lowerQuery.startsWith('delete')
    )) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Only INSERT, UPDATE, or DELETE operations are allowed with write_query'
      );
    }

    // Additional validation
    const validationError = validateQuery(query);
    if (validationError) {
      throw new McpError(ErrorCode.InvalidParams, validationError);
    }

    const connection = await this.getConnection(connectionId, args.database);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }
    await this.assertWritable(connection, query);

    const result = await this.workspaceClient.executeQuery(connection, query);

    const response = {
      query: query,
      connection: sanitizeDiagnostic(connection.name),
      executionTime: result.executionTime,
      affectedRows: result.affectedRows === undefined ? result.rowCount : result.affectedRows,
      success: true,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  private async handleRunScript(args: {
    connectionId: string;
    database?: string;
    script?: string;
    file?: string;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    let statements: string[];
    let text: string;
    try {
      text = resolveQueryText({ query: args.script, file: args.file });
      statements = scriptStatements(text);
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, formatError(error));
    }
    const connection = await this.getConnection(connectionId, args.database);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }
    this.assertNotReadOnly(connection);
    if (connection.askBeforeWrite) {
      // The user approves exactly what runs, so a script too long to show is
      // refused rather than shortened.
      const shown = describeScriptForApproval(statements, text, args.file);
      if (!shown)
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Script is too long to show for approval (limit ${MAX_APPROVAL_CHARS} characters); split it into several run_script calls`
        );
      await this.askApproval(connection, shown, `Run all ${statements.length} statements`);
    }
    const started = Date.now();
    let results;
    try {
      results = await this.transactionManager.runScript(connection, statements);
    } catch (error) {
      throw new McpError(ErrorCode.InvalidRequest, sanitizeDiagnostic(formatError(error)));
    }
    return this.toolResult({
      connection: sanitizeDiagnostic(connection.name),
      committed: true,
      statements: results.length,
      executionTime: Date.now() - started,
      results,
    });
  }

  private async handleCreateTable(args: {
    connectionId: string;
    database?: string;
    query: string;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();

    const statementError = validateStatement(query);
    if (statementError) throw new McpError(ErrorCode.InvalidParams, statementError);

    if (!query.toLowerCase().startsWith('create table')) {
      throw new McpError(ErrorCode.InvalidParams, 'Only CREATE TABLE statements are allowed');
    }

    const connection = await this.getConnection(connectionId, args.database);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }
    await this.assertWritable(connection, query);

    const result = await this.workspaceClient.executeQuery(connection, query);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: 'Table created successfully',
              executionTime: result.executionTime,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleAlterTable(args: { connectionId: string; database?: string; query: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();

    const statementError = validateStatement(query);
    if (statementError) throw new McpError(ErrorCode.InvalidParams, statementError);

    if (!query.toLowerCase().startsWith('alter table')) {
      throw new McpError(ErrorCode.InvalidParams, 'Only ALTER TABLE statements are allowed');
    }

    const connection = await this.getConnection(connectionId, args.database);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }
    await this.assertWritable(connection, query);

    const result = await this.workspaceClient.executeQuery(connection, query);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: 'Table altered successfully',
              executionTime: result.executionTime,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleDropTable(args: {
    connectionId: string;
    database?: string;
    tableName: string;
    confirm: boolean;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const tableName = args.tableName;

    if (!tableName) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
    }

    if (args.confirm !== true) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: false,
                message:
                  'Safety confirmation required. Set confirm=true to proceed with dropping the table.',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const connection = await this.getConnection(connectionId, args.database);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }
    // Refuse read-only connections before touching the table; ask once the SQL is known.
    this.assertNotReadOnly(connection);

    // Check if table exists first
    try {
      await this.workspaceClient.getTableSchema(connection, tableName);
    } catch {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Table '${tableName}' does not exist or cannot be accessed`
      );
    }

    const dropQuery = `DROP TABLE ${quoteQualifiedIdentifier(tableName, connection.driver)}`;
    await this.assertWritable(connection, dropQuery);
    const result = await this.workspaceClient.executeQuery(connection, dropQuery);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: `Table '${tableName}' dropped successfully`,
              executionTime: result.executionTime,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetTableSchema(args: {
    connectionId: string;
    database?: string;
    tableName: string;
    includeIndexes?: boolean;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const source = this.catalogSource(connection);
    const schema = await this.workspaceClient.getTableSchema(connection, args.tableName);

    if (args.includeIndexes === false) {
      (schema as any).indexes = undefined;
    }

    return this.presentDocument(schema, source);
  }

  private async handleExportData(args: {
    connectionId: string;
    database?: string;
    query: string;
    format?: string;
    compression?: ExportCompression;
    includeHeaders?: boolean;
    maxRows?: number;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();

    const policyError = validateQuery(query) || enforceReadOnly(query);
    if (policyError) throw new McpError(ErrorCode.InvalidParams, policyError);

    const connection = await this.getConnection(connectionId, args.database);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const requestedRows = args.maxRows || DEFAULT_EXPORT_ROWS;
    const maxRows = Math.min(Math.max(1, requestedRows), MAX_EXPORT_ROWS);
    const format = args.format || 'csv';
    if (format !== 'csv' && format !== 'json')
      throw new McpError(ErrorCode.InvalidParams, 'Unsupported export format; use csv or json');

    const source = this.artifactSource(connection, query);
    const streamed = await this.streamExport(connection, query, source, {
      format,
      compression: args.compression ?? 'none',
      includeHeaders: args.includeHeaders !== false,
      requestedRows,
    });
    if (streamed) return streamed;
    const result = await this.workspaceClient.executeQuery(connection, query, {
      maxRows,
      readOnly: true,
    });

    const duplicateColumns = new Set(result.columns).size !== result.columns.length;
    const text =
      format === 'csv'
        ? convertToCSV(result.columns, result.rows, args.includeHeaders !== false)
        : JSON.stringify(
            duplicateColumns
              ? { columns: result.columns, rows: result.rows }
              : result.rows.map((row) =>
                  Object.fromEntries(result.columns.map((name, i) => [name, row[i]]))
                )
          );
    const compression = args.compression ?? 'none';
    const bytes = Buffer.byteLength(text);
    if (compression !== 'none' || bytes > 65536) {
      const data =
        compression === 'none'
          ? text
          : await compressText(text, compression, connection.limits?.timeoutMs);
      const stored = await this.artifacts.export(
        data,
        format + compressionExtension[compression],
        source
      );
      const response = {
        ...stored,
        compression,
        uncompressedBytes: bytes,
        truncated: result.truncated === true,
        rowCount: result.rows.length,
        downloadTool: 'read_export',
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response) }],
        structuredContent: response,
      };
    }
    return {
      content: [{ type: 'text' as const, text }],
      ...(result.truncated
        ? {
            structuredContent: {
              truncated: true,
              rowCount: result.rows.length,
              limitReason: result.limitReason,
            },
          }
        : {}),
    };
  }

  /**
   * Stream a PostgreSQL or MySQL/MariaDB export straight to an artifact file,
   * so the row cap is bounded by bytes on disk rather than memory. Returns null
   * for engines that keep the buffered path.
   */
  private async streamExport(
    connection: DatabaseConnection,
    query: string,
    source: ArtifactSource,
    request: ExportRequest
  ) {
    const dialect = sqlDialect(connection.driver);
    if (dialect !== 'postgres' && dialect !== 'mysql') return null;
    const limits = connectionStreamLimits(this.exportSettings.export, connection);
    const caps = {
      maxRows: Math.min(
        Math.max(1, request.requestedRows),
        limits.maxRows,
        connection.limits?.maxRows ?? Infinity
      ),
      maxBytes: limits.maxBytes,
    };
    await this.workspaceClient.assertQueryAccess(connection, query, true);
    const entry = await this.poolManager.getPool(connection);
    if (!entry) return null;
    const { compression } = request;
    let writer: ExportWriter | undefined;
    let stored;
    try {
      ({ stored } = await this.artifacts.exportStream(
        request.format + compressionExtension[compression],
        source,
        Math.min(limits.maxBytes + 65536, this.exportSettings.artifactQuotaBytes),
        (sink) =>
          withCompression(sink, compression, async (out) => {
            writer = new ExportWriter(
              out,
              new ExportEncoder(request.format, request.includeHeaders),
              caps
            );
            if (entry.type === 'postgres')
              await this.streamPostgresExport(
                entry.pool as PgPool,
                query,
                writer,
                limits.timeoutMs
              );
            else
              await this.streamMysqlExport(
                entry.pool as MySqlPool,
                query,
                writer,
                limits.timeoutMs,
                connection.limits?.timeoutMs ?? 30000
              );
          })
      ));
    } catch (error) {
      throw new Error(`Query execution failed: ${sanitizeDiagnostic(error)}`);
    }
    const summary = {
      truncated: writer!.truncated,
      rowCount: writer!.rows,
      ...(writer!.limitReason ? { limitReason: writer!.limitReason } : {}),
    };
    if (compression === 'none') {
      const inline = await this.artifacts.takeInline(stored.resultId, 65536);
      if (inline)
        return {
          content: [{ type: 'text' as const, text: inline.toString('utf8') }],
          ...(summary.truncated ? { structuredContent: summary } : {}),
        };
    }
    const response = {
      ...stored,
      compression,
      uncompressedBytes: writer!.bytes,
      ...summary,
      streamed: true,
      downloadTool: 'read_export',
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      structuredContent: response,
    };
  }

  private async streamPostgresExport(
    pool: PgPool,
    query: string,
    writer: ExportWriter,
    timeoutMs: number
  ) {
    const client = await pool.connect();
    let broken = false,
      released = false;
    try {
      await client.query('BEGIN READ ONLY');
      // The pool's statement_timeout is sized for interactive queries.
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
      await streamPostgres(client, query, writer, {
        timeoutMs,
        abort: () => {
          broken = true;
          released = true;
          client.release(true);
        },
      });
    } catch (error) {
      broken = true;
      throw error;
    } finally {
      if (!broken) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
      }
      if (!released) client.release(broken);
    }
  }

  private async streamMysqlExport(
    pool: MySqlPool,
    query: string,
    writer: ExportWriter,
    timeoutMs: number,
    acquireTimeoutMs: number
  ) {
    const conn = await acquireLease(pool.getConnection(), acquireTimeoutMs, (lease) =>
      lease.release()
    );
    let broken = false;
    const destroy = () => {
      if (broken) return;
      broken = true;
      conn.destroy();
    };
    try {
      await conn.query('START TRANSACTION READ ONLY');
      await streamMysql(conn, query, writer, { timeoutMs, abort: destroy });
    } catch (error) {
      destroy();
      throw error;
    } finally {
      if (!broken) {
        try {
          await conn.rollback();
          conn.release();
        } catch {
          destroy();
        }
      }
    }
  }

  /** pg_dump / mysqldump into the artifact store; failures return a structured error code. */
  private async handleDump(
    tool: 'dump_table' | 'dump_database',
    args: DumpOptions & {
      connectionId: string;
      database?: string;
      compression?: ExportCompression;
      saveToFile?: boolean;
      fileName?: string;
    }
  ) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }
    try {
      const flavor = dumpFlavorFor(connection.driver);
      if (!flavor)
        throw new DumpError(
          'DUMP_UNSUPPORTED_DRIVER',
          'Dumps support PostgreSQL and MySQL/MariaDB connections'
        );
      const tables = args.tables ?? [];
      if (tool === 'dump_table' && !tables.length)
        throw new DumpError('DUMP_INVALID_OPTIONS', 'dump_table needs at least one table', {
          field: 'tables',
        });
      // A whole-database dump would bypass table rules; require an explicit list.
      if (!tables.length && this.accessPolicy.hasTableRestrictions(connection))
        throw new DumpError(
          'DUMP_INVALID_OPTIONS',
          'The access policy restricts tables; list the tables to dump',
          { field: 'tables' }
        );
      for (const table of tables) await this.workspaceClient.assertTableAccess(connection, table);
      const options = { tables, schemaOnly: args.schemaOnly, dataOnly: args.dataOnly };
      const binary = resolveDumpBinary(flavor);
      const command = buildDumpCommand(
        binary,
        await resolveDumpTarget(connection, flavor, { debug: this.debug }),
        options
      );
      const compression = args.compression ?? 'none';
      const limits = connectionStreamLimits(this.exportSettings.dump, connection);
      if (args.saveToFile) return await this.dumpToFile(connection, command, binary, args, limits);
      if (args.fileName)
        throw new DumpError('DUMP_INVALID_OPTIONS', 'fileName needs saveToFile', {
          field: 'fileName',
        });
      const { stored, value } = await this.artifacts.exportStream(
        'sql' + compressionExtension[compression],
        this.catalogSource(connection),
        Math.min(limits.maxBytes + 65536, this.exportSettings.artifactQuotaBytes),
        (sink) =>
          withCompression(sink, compression, (out) =>
            runDump(command, { timeoutMs: limits.timeoutMs, maxBytes: limits.maxBytes, sink: out })
          )
      );
      const response = {
        ...stored,
        kind: 'dump',
        client: binary.flavor,
        compression,
        uncompressedBytes: value.bytes,
        tables,
        schemaOnly: args.schemaOnly === true,
        dataOnly: args.dataOnly === true,
        ...(command.tlsHostnameVerified === false ? { tlsHostnameVerified: false } : {}),
        downloadTool: 'read_export',
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response) }],
        structuredContent: response,
      };
    } catch (error) {
      if (!(error instanceof DumpError)) throw error;
      const payload = {
        error: error.code,
        message: sanitizeDiagnostic(error.message),
        ...error.details,
      };
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    }
  }

  /**
   * Stream a dump straight into a new file in the dump folder. It skips the
   * artifact store, so the larger file cap applies; a failure removes the file.
   */
  private async dumpToFile(
    connection: DatabaseConnection,
    command: ReturnType<typeof buildDumpCommand>,
    binary: ReturnType<typeof resolveDumpBinary>,
    args: DumpOptions & { compression?: ExportCompression; fileName?: string },
    limits: { timeoutMs: number }
  ) {
    const compression = args.compression ?? 'none';
    const slug =
      connection.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'dump';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const name = args.fileName ?? `${slug}-${stamp}.sql${compressionExtension[compression]}`;
    const { path: file, handle } = await createDumpFile(name, dumpDirectory());
    const output = handle.createWriteStream();
    let value: { bytes: number };
    try {
      value = await withCompression(output, compression, (out) =>
        runDump(command, {
          timeoutMs: limits.timeoutMs,
          maxBytes: this.exportSettings.dump.fileMaxBytes,
          sink: out,
        })
      );
      if (!output.writableEnded) output.end();
      await finished(output);
    } catch (error) {
      output.destroy();
      await fs.promises.rm(file, { force: true });
      throw error;
    }
    const response = {
      kind: 'dump',
      path: file,
      bytes: (await fs.promises.stat(file)).size,
      uncompressedBytes: value.bytes,
      client: binary.flavor,
      compression,
      tables: args.tables ?? [],
      schemaOnly: args.schemaOnly === true,
      dataOnly: args.dataOnly === true,
      ...(command.tlsHostnameVerified === false ? { tlsHostnameVerified: false } : {}),
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      structuredContent: response,
    };
  }

  private async handleTestConnection(args: { connectionId: string; database?: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const testResult = {
      ...(await this.workspaceClient.testConnection(connection)),
      connectionId: publicConnectionId(connection),
    };
    if (testResult.error) testResult.error = sanitizeDiagnostic(testResult.error);
    if (testResult.databaseVersion)
      testResult.databaseVersion = safeDatabaseVersion(testResult.databaseVersion);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(testResult, null, 2),
        },
      ],
    };
  }

  private async handleGetDatabaseStats(args: { connectionId: string; database?: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const source = this.catalogSource(connection);
    const stats = await this.workspaceClient.getDatabaseStats(connection);
    return this.presentDocument(
      {
        ...stats,
        connectionId: publicConnectionId(connection),
        serverVersion: safeDatabaseVersion(stats.serverVersion) ?? 'Unavailable',
      },
      source
    );
  }

  private async handleListTables(args: {
    connectionId: string;
    database?: string;
    schema?: string;
    includeViews?: boolean;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const source = this.catalogSource(connection);
    const tables = await this.workspaceClient.listTables(
      connection,
      args.schema,
      args.includeViews || false
    );

    return this.presentDocument(tables, source);
  }

  private async handleAppendInsight(args: {
    insight: string;
    connection?: string;
    tags?: string[];
  }) {
    this.refreshNotes();
    if (!args.insight || args.insight.trim().length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Insight text is required');
    }

    const connection = args.connection ? await this.getConnection(args.connection) : undefined;
    if (args.connection && !connection) throw new Error('Insight connection is not accessible');
    const newInsight: BusinessInsight = {
      id: Math.max(Date.now(), ...this.insights.map((n) => n.id)) + 1,
      insight: args.insight.trim(),
      created_at: new Date().toISOString(),
      connection: connection?.id,
      tags: args.tags || [],
    };

    this.insights.push(newInsight);
    this.saveInsights();

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: 'Insight added successfully',
              id: newInsight.id,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleListInsights(args: { connection?: string; tags?: string[] }) {
    this.refreshNotes();
    const visible = await this.getFilteredConnections();
    const connections = new Map(
      visible.flatMap(
        (connection) =>
          [
            [connection.id, connection],
            [publicConnectionId(connection), connection],
          ] as [string, DatabaseConnection][]
      )
    );
    for (const connection of visible) {
      if (
        !connections.has(connection.name) &&
        visible.filter((c) => c.name === connection.name).length === 1
      )
        connections.set(connection.name, connection);
    }
    let filteredInsights = this.insights.filter(
      (n) => !n.connection || connections.has(n.connection)
    );

    if (args.connection) {
      const selected = connections.get(args.connection);
      filteredInsights = filteredInsights.filter(
        (insight) => !!selected && connections.get(insight.connection ?? '')?.id === selected.id
      );
    }

    if (args.tags && args.tags.length > 0) {
      filteredInsights = filteredInsights.filter(
        (insight) => insight.tags && args.tags!.some((tag) => insight.tags!.includes(tag))
      );
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            filteredInsights.map((insight) => ({
              ...insight,
              ...(insight.connection
                ? { connection: publicConnectionId(connections.get(insight.connection)!) }
                : {}),
            })),
            null,
            2
          ),
        },
      ],
    };
  }

  // Transaction handlers
  private async handleBeginTransaction(args: { connectionId: string; database?: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }
    // Ask connections approve each write statement inside the transaction instead.
    this.assertNotReadOnly(connection);

    const result = await this.transactionManager.beginTransaction(connection);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleCommitTransaction(args: { transactionId: string }) {
    const result = await this.transactionManager.commitTransaction(args.transactionId);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleRollbackTransaction(args: { transactionId: string }) {
    const result = await this.transactionManager.rollbackTransaction(args.transactionId);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleExecuteInTransaction(args: { transactionId: string; query: string }) {
    const validationError = validateQuery(args.query);
    if (validationError) {
      throw new McpError(ErrorCode.InvalidParams, validationError);
    }

    const transaction = this.transactionManager.getTransaction(args.transactionId);
    if (!transaction) throw new Error('Transaction not found or expired');
    const scope = this.transactionManager.resultScope(args.transactionId);
    // Recheck live: access may have changed since the transaction began. The
    // session can write, and the read classifier is a blocklist (a SELECT can
    // call a writing function), so ask connections approve every statement.
    const current = await this.getConnection(scope.connection.id);
    if (!current) throw new Error('Transaction connection is no longer accessible');
    if (current.askBeforeWrite || enforceReadOnly(args.query) !== null)
      await this.assertWritable(current, args.query);
    const source = this.artifactSource(scope.connection, args.query, scope.policyRevision);
    const result = await this.transactionManager.executeInTransaction(
      args.transactionId,
      args.query
    );
    return this.presentResult(result, source, { transactionId: args.transactionId });
  }

  // Query analysis handlers
  private async handleExplainQuery(args: {
    connectionId: string;
    database?: string;
    query: string;
    analyze?: boolean;
    format?: 'text' | 'json';
  }) {
    const policyError = validateQuery(args.query) || enforceReadOnly(args.query);
    if (policyError) throw new McpError(ErrorCode.InvalidParams, policyError);
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    if (args.analyze && connection.driver.toLowerCase().includes('oracle')) {
      // An actual plan would mean running the statement; EXPLAIN PLAN never does.
      throw new McpError(
        ErrorCode.InvalidParams,
        'analyze is not supported for Oracle: only the estimated plan (EXPLAIN PLAN) is available'
      );
    }

    const format = args.format || 'text';
    await this.workspaceClient.assertQueryAccess(connection, args.query, true);
    const dialect = connection.driver.toLowerCase();
    const isSqlServer = /mssql|sqlserver|microsoft/.test(dialect);
    if (isSqlServer && args.analyze)
      throw new McpError(
        ErrorCode.InvalidParams,
        'SQL Server supports estimated plans here; analyze is unavailable'
      );
    const result = isSqlServer
      ? await this.workspaceClient.explainSqlServerQuery(connection, args.query, format)
      : dialect.includes('oracle')
        ? await this.workspaceClient.explainOracleQuery(connection, args.query)
        : await this.workspaceClient.executeQuery(
            connection,
            buildExplainQuery(connection.driver, args.query, args.analyze || false, format),
            { readOnly: true, trustedMetadata: true }
          );
    const explainResult = parseExplainOutput(connection.driver, result.rows, args.query, format);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(explainResult, null, 2),
        },
      ],
    };
  }

  // Schema comparison handlers
  private async handleCompareSchemas(args: {
    sourceConnectionId: string;
    targetConnectionId: string;
    includeMigrationScript?: boolean;
  }) {
    const sourceConnId = sanitizeConnectionId(args.sourceConnectionId);
    const targetConnId = sanitizeConnectionId(args.targetConnectionId);

    const sourceConn = await this.getConnection(sourceConnId);
    const targetConn = await this.getConnection(targetConnId);

    if (!sourceConn) {
      throw new McpError(ErrorCode.InvalidParams, `Source connection not found: ${sourceConnId}`);
    }
    if (!targetConn) {
      throw new McpError(ErrorCode.InvalidParams, `Target connection not found: ${targetConnId}`);
    }

    const source = this.catalogSource(sourceConn, targetConn);
    const defaultTimeout = integerSetting(process.env.HOPSQL_TIMEOUT, 'HOPSQL_TIMEOUT', 30000);
    const deadline =
      Date.now() +
      Math.min(
        sourceConn.limits?.timeoutMs ?? defaultTimeout,
        targetConn.limits?.timeoutMs ?? defaultTimeout
      );
    const checkDeadline = () => {
      if (Date.now() >= deadline)
        throw new Error(
          'Schema comparison budget exhausted; narrow the request with table policies'
        );
    };
    // Bound total catalog work as well as each native metadata query.
    const sourceTables = await this.workspaceClient.listTables(sourceConn);
    checkDeadline();
    const targetTables = await this.workspaceClient.listTables(targetConn);
    if (sourceTables.length > 1000 || targetTables.length > 1000)
      throw new Error(
        'Schema comparison table limit is 1000 per connection; narrow the request with table policies'
      );

    let bytes = 0;
    const load = async (connection: DatabaseConnection, tables: any[]) => {
      const schemas = [];
      for (let offset = 0; offset < tables.length; offset += 4) {
        checkDeadline();
        const batch = await Promise.all(
          tables.slice(offset, offset + 4).map(async (table) => {
            const name = [table.table_schema, table.name].filter(Boolean).join('.');
            const schema = await this.workspaceClient.getTableSchema(connection, name);
            bytes += Buffer.byteLength(JSON.stringify(schema));
            if (bytes > 16 * 1024 * 1024)
              throw new Error(
                'Schema comparison catalog exceeds 16 MiB; narrow the request with table policies'
              );
            return comparableSchema(schema);
          })
        );
        checkDeadline();
        schemas.push(...batch);
      }
      return schemas;
    };
    const sourceSchemas = await load(sourceConn, sourceTables);
    const targetSchemas = await load(targetConn, targetTables);

    checkDeadline();
    const diff = await compareSchemas(
      sourceSchemas,
      targetSchemas,
      publicConnectionId(sourceConn),
      publicConnectionId(targetConn)
    );

    const response: { diff: SchemaDiff; migrationScript?: string } = { diff };

    if (args.includeMigrationScript) {
      response.migrationScript = generateMigrationScript(diff, targetConn.driver);
    }

    return this.presentDocument(response, source);
  }

  // Pool management handlers
  private async handleGetPoolStats(args: { connectionId: string; database?: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    // Initialize pool if needed
    await this.poolManager.getPool(connection);
    const stats = await this.poolManager.getStats(connection);

    if (!stats) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              connectionId: publicConnectionId(connection),
              message: 'No pool available for this connection type',
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ...stats, connectionId: publicConnectionId(connection) }, null, 2),
        },
      ],
    };
  }

  /**
   * Effective read-only state. Policy-file rules always hold; otherwise an
   * access mode set in the managed file (`hopsql manage` / `hopsql access`)
   * wins over the HOPSQL_READ_ONLY ceiling, so it applies without a restart.
   */
  private isReadOnly(connection: DatabaseConnection): boolean {
    return this.accessPolicy.isReadOnly(connection) || (this.readOnly && !connection.accessManaged);
  }

  /** Whether any connection can take writes now; decides if write tools are listed. */
  private writesPossible(): boolean {
    if (!this.readOnly) return true;
    try {
      return Object.values(loadManagedOverrides()).some(
        (override) => (overrideAccess(override) ?? 'read-only') !== 'read-only'
      );
    } catch {
      return false;
    }
  }

  private assertNotReadOnly(connection: DatabaseConnection): void {
    if (this.isReadOnly(connection))
      throw new McpError(ErrorCode.InvalidRequest, 'This saved connection is read-only');
  }

  /**
   * Refuse read-only connections; on `ask` connections, have the user approve
   * this one statement in the client. Approval never carries over to another call.
   */
  private async assertWritable(connection: DatabaseConnection, sql: string): Promise<void> {
    this.assertNotReadOnly(connection);
    if (!connection.askBeforeWrite) return;
    // The user must see exactly what runs: never truncate, and collapse
    // whitespace so padding cannot push part of the statement out of view.
    if (sql.length > 4000)
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Statement is too long to show for approval; split it into smaller statements'
      );
    await this.askApproval(connection, sql.replace(/\s+/g, ' ').trim(), 'Run this statement');
  }

  /** Ask the user in the client to approve a write on an `ask` connection. */
  private async askApproval(
    connection: DatabaseConnection,
    shown: string,
    label: string
  ): Promise<void> {
    if (!this.server.getClientCapabilities()?.elicitation)
      throw new McpError(
        ErrorCode.InvalidRequest,
        'This connection asks before each write, and this client cannot ask the user'
      );
    const result = await this.server.elicitInput(
      {
        message: `Hopsql: allow this write on "${connection.name}"?\n\n${shown}`,
        requestedSchema: {
          type: 'object',
          properties: { approve: { type: 'boolean', title: label, default: false } },
          required: ['approve'],
        },
      },
      { timeout: 5 * 60 * 1000 }
    );
    if (result.action !== 'accept' || result.content?.approve !== true)
      throw new McpError(ErrorCode.InvalidRequest, 'The user did not approve this write');
  }

  private queryArgument(args: Record<string, unknown>): string {
    try {
      return resolveQueryText(args as { query?: string; file?: string });
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, formatError(error));
    }
  }

  private toolResult(value: object) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent: value as Record<string, unknown>,
    };
  }

  /**
   * Install the latest release, but only after the user confirms in the client:
   * the installer downloads and builds code, so a model alone may not start it.
   */
  private async handleUpdate() {
    const status = await getUpdateStatus(VERSION, { maxAgeMs: 0 });
    if (!status.updateAvailable) return { ...status, updated: false };
    const location = installLocation();
    if (!location)
      throw new McpError(
        ErrorCode.InvalidRequest,
        'This copy was not installed by the Hopsql installer; update its checkout instead'
      );
    if (!this.server.getClientCapabilities()?.elicitation)
      throw new McpError(
        ErrorCode.InvalidRequest,
        `This client cannot ask the user to confirm. Ask them to run "${status.command}" in a terminal.`
      );
    const result = await this.server.elicitInput(
      {
        message: `Hopsql: install ${status.latest!.version} (installed: ${VERSION}) from ${status.latest!.url}? MCP clients need a restart afterwards.`,
        requestedSchema: {
          type: 'object',
          properties: { install: { type: 'boolean', title: 'Install update', default: false } },
          required: ['install'],
        },
      },
      { timeout: 5 * 60 * 1000 }
    );
    if (result.action !== 'accept' || result.content?.install !== true)
      return { ...status, updated: false, declined: true };
    await runUpdate(status.latest!.tag, { location, output: 'stderr' });
    return { ...status, updated: true, restartRequired: true };
  }

  /**
   * A saved connection for `hopsql exec`, under the same allowlist and access
   * policy as the tools. Raw credentials bypass the SQL policy, so read-only
   * connections are refused; `ask` connections are approved by runExec.
   */
  async connectionForExec(connectionId: string, database?: string): Promise<DatabaseConnection> {
    const connection = await this.getConnection(sanitizeConnectionId(connectionId), database);
    if (!connection) throw new Error(`Connection not found: ${connectionId}`);
    if (this.accessPolicy.isReadOnly(connection))
      throw new Error(
        'This connection is read-only in Hopsql; injected credentials would bypass that. Use "hopsql access ask <connection>" (approve each run) or "writable" to use exec.'
      );
    return connection;
  }

  /**
   * Access is re-read on every call; this only tells the client when write
   * tools appear or disappear, so it refreshes its tool list without a restart.
   */
  private watchManagedAccess(): void {
    let writes = this.writesPossible();
    fs.watchFile(managedOverridesPath(), { interval: 1000, persistent: false }, () => {
      const now = this.writesPossible();
      if (now === writes) return;
      writes = now;
      this.server.sendToolListChanged().catch(() => {
        /* A client that ignores list changes still gets the live checks. */
      });
    });
  }

  /** Ask the user, through the MCP client, whether to trust an unknown SSH host key. */
  private async askToTrustHostKey(question: HostKeyQuestion): Promise<boolean> {
    const result = await this.server.elicitInput(
      {
        message:
          `Hopsql: SSH host ${question.host}:${question.port} (connection "${question.connectionName}") ` +
          `is not in known_hosts.\n\n${question.keyType} ${question.fingerprint}\n\n` +
          'Only trust it if this fingerprint matches one from a source you trust. ' +
          'Trusting saves it to known_hosts.',
        requestedSchema: {
          type: 'object',
          properties: {
            trust: { type: 'boolean', title: 'Trust this host key', default: false },
          },
          required: ['trust'],
        },
      },
      // The user may need time to check the fingerprint.
      { timeout: 5 * 60 * 1000 }
    );
    return result.action === 'accept' && result.content?.trust === true;
  }

  async run() {
    try {
      // Validate DB client workspace
      if (!process.env.HOPSQL_CONFIG_FILE && !this.configParser.isWorkspaceValid()) {
        this.log(
          'Workspace not found. Please run your DB client at least once to create the workspace.',
          'error'
        );
        this.log(
          'The server will start but will not be able to access any database connections.',
          'error'
        );
      }

      const transport = new StdioServerTransport();
      this.server.oninitialized = () => {
        // Only a client that can ask the user gets to approve unknown host keys.
        if (this.server.getClientCapabilities()?.elicitation)
          sshTunnelManager.setHostKeyPrompt((question) => this.askToTrustHostKey(question));
      };
      await this.server.connect(transport);

      this.log('Hopsql MCP server started successfully');
      void checkForUpdate(VERSION);
      this.watchManagedAccess();

      // Periodic cleanup of stale transactions (leaked transactions older than 1 hour)
      this.staleCleanupInterval = setInterval(async () => {
        try {
          const cleaned = await this.transactionManager.cleanupStaleTransactions();
          if (cleaned > 0) {
            this.log(`Cleaned up ${cleaned} stale transaction(s)`);
          }
        } catch (error) {
          this.log(`Stale transaction cleanup error: ${formatError(error)}`, 'debug');
        }
      }, STALE_TRANSACTION_CHECK_MS);
      this.staleCleanupInterval.unref(); // Don't prevent process exit

      if (this.readOnly) {
        this.log('Read-only mode enabled: write operations are disabled');
      }
      if (this.allowedConnections) {
        this.log(
          `Connection whitelist active (${this.allowedConnections.size} configured selectors)`
        );
      }

      if (this.debug) {
        this.log('Debug diagnostics enabled; connection infrastructure is private', 'debug');
      }
    } catch (error) {
      this.log(`Failed to start server: ${formatError(error)}`, 'error');
      process.exit(1);
    }
  }
}

/** A server that is never connected to a transport, for CLI commands. */
export function createServer(): HopsqlMCPServer {
  return new HopsqlMCPServer();
}

export async function startServer(): Promise<void> {
  const server = new HopsqlMCPServer();
  await server.run();
}
