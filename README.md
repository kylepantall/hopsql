# Hopsql

[![CI](https://github.com/kylepantall/hopsql/actions/workflows/ci.yml/badge.svg)](https://github.com/kylepantall/hopsql/actions/workflows/ci.yml) [![MIT license](https://img.shields.io/badge/license-MIT-716e65)](LICENSE)

Give Claude Code, Codex and OpenCode read-only access to the databases you already use — including the ones behind bastions. Hopsql reuses your saved DBeaver connections, follows their SSH jump hosts (or AWS SSM), and queries with native drivers.

> **Hopsql is a fork of [omnisql-mcp](https://github.com/srthkdev/omnisql-mcp)** by Sarthak Jain, based on its v3.0.0 release. It is maintained separately, is not published to npm, and installs straight from this repo. Thanks to the omnisql-mcp authors and contributors for the foundation. See [what's different](#whats-different-from-hopsql).

[Quick setup](#quick-setup) · [Features](#what-you-can-do) · [Docs](docs/README.md) · [Changelog](CHANGELOG.md)

## What's different from omnisql-mcp

| Area | Hopsql |
|---|---|
| **SSH jump hosts** | Follows DBeaver's jump-server chain, checking every host key along the way. |
| **AWS SSM** | Reaches bastions with no public SSH, over Session Manager (as an SSH transport or a direct port forward). |
| **SSH agents** | Finds your agent automatically, including the 1Password SSH agent, on macOS, Linux and Windows. |
| **Reliability** | Dropped tunnels reconnect on the same local port, pools rebuild, and read-only queries retry once. |
| **Postgres TLS** | No `sslmode` behaves like DBeaver (`prefer`): TLS first, plaintext only if the server has none. |
| **Dumps and exports** | New `dump_table` / `dump_database` (via `pg_dump` / `mysqldump`) and streaming `export_data` for large results. |
| **Manage UI** | `hopsql` in a terminal: make a connection read-only, or add an AWS SSM hop and Secrets Manager login, without editing JSON. |
| **Install** | One command from GitHub for macOS, Linux and Windows; no npm package. |
| **Names** | `hopsql` binary and MCP entry, `HOPSQL_*` settings. Legacy `OMNISQL_*` settings still work. |

## What you can do

| Capability | How it helps |
|---|---|
| **Reach databases behind bastions** | Use DBeaver's saved SSH tunnels and jump hosts as-is, or add AWS SSM hops. |
| **Reuse saved connections** | Read database and SSH settings from DBeaver-compatible workspaces, including custom projects. |
| **Query across engines** | PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, Oracle, DuckDB, and ClickHouse. |
| **Choose another database** | Discover databases and select one at call time, using the same saved server credentials. |
| **Understand your data** | Browse tables, inspect columns, explain queries, export CSV/JSON, and compare schemas. |
| **Control access** | Choose read-only mode, restrict connections, or disable tools. |
| **Set up your client** | One guided command for Claude Code, Codex, and OpenCode. |

## Database Support

**Supported execution paths**:
- PostgreSQL (via `pg`)
- MySQL / MariaDB (via `mysql2`)
- SQL Server / MSSQL (via `mssql`)
- SQLite (via `sqlite3` CLI)
- ClickHouse (HTTP/HTTPS with keep-alive and zstd/gzip; no external client)
- DuckDB (via DuckDB CLI 1.5.6+; existing local files, locked safe mode, exact numeric output)
- Oracle (via `oracledb`)

**Postgres-compatible** (routed through `pg` driver automatically):
- CockroachDB, TimescaleDB, Amazon Redshift, YugabyteDB, AlloyDB, Supabase, Neon, Citus

**Other databases**: Unsupported drivers return an explicit error. External GUI/CLI query fallback has been removed so access and output policies remain enforceable.

DuckDB uses an installed CLI so its native binary stays out of the npm package. Install it with `brew install duckdb` on macOS, or use the [official downloads](https://duckdb.org/install/). Set `HOPSQL_DUCKDB_CLI` if the executable is outside your MCP client's PATH. See [database support](docs/guides/databases.md) for configuration and limits.

**Custom drivers** wrapping any of the above are detected automatically — see [Custom and IAM-Authenticated Drivers](#custom-and-iam-authenticated-drivers).

## Requirements

- macOS, Linux or Windows. The installer provides Bun 1.4.3+ if you don't have it; the built server also runs on Node.js 22.15+ or 24+.
- A database connection or an existing DBeaver-compatible workspace
- Per feature, a few command-line tools; `hopsql doctor` shows which you have and need
- For `dump_*` tools: `pg_dump` (`brew install libpq` / `winget install PostgreSQL.PostgreSQL`) or `mariadb-dump`/`mysqldump` (`brew install mariadb-connector-c` or `mysql-client` / `winget install MariaDB.Server`)

## Quick setup

One command installs and registers it with Claude Code; no clone, Node.js or Bun needed. To upgrade, run it again without `--claude` / `-Claude`.

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/kylepantall/hopsql/main/scripts/install.sh | bash -s -- --claude
```

**Windows (PowerShell)**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/hopsql/main/scripts/install.ps1))) -Claude
```

| What it does | macOS / Linux | Windows |
|---|---|---|
| Downloads and builds this repo | `~/.local/share/hopsql` | `%LOCALAPPDATA%\hopsql` |
| Launcher | `~/.local/bin/hopsql` | `%LOCALAPPDATA%\hopsql\bin\hopsql.cmd` |
| Runtime | Your Bun 1.4.3+, or a private checksum-verified copy | Same |
| `--claude` / `-Claude` | Registers with Claude Code (user scope); stops if a `hopsql` or legacy `omnisql` entry exists | Same |
| `--force` / `-Force` | With `--claude`, replaces that entry; its env (allowlist, config file) is not kept | Same |

Leave out `--claude` / `-Claude` to install only. Pin a branch, tag or commit with `bash -s -- --claude <ref>` or `-Ref <ref>`. `HOPSQL_INSTALL_DIR` and `HOPSQL_BIN_DIR` choose other directories. Start a new Claude session after setup.

### Guided setup and other clients

After installing, run the guided installer from the launcher to pick Claude Code, Codex or OpenCode and choose connections:

```bash
hopsql install
```

It registers the installed launcher, never the upstream npm package. The installer detects clients and offers direct database setup, an existing Hopsql config, or selected DBeaver connections. Add multiple instances to one MCP server, each with its own read-only setting and table rules. Direct setup uses verified TLS by default; passwords are masked and saved only in a private local config (0600 on Unix), or referenced through environment variable names. No Hopsql API key is needed. An agent with unrestricted file access can still read local config files. Start a new client session after setup.

To add it to a specific client directly:

```bash
hopsql install claude
hopsql install codex
hopsql install opencode
```

Registrations default to read-only. `install <client>` opens guided setup in a terminal. For noninteractive setup, provide `--config /path/to/connections.json`, or `--workspace /path/to/workspace --allow dev,analytics` for selected saved connections. Explicit config excludes workspace discovery. `--dry-run` previews registration. An existing `hopsql` entry is kept unless you confirm replacing it in guided setup or pass `--replace` (Claude Code and Codex; remove OpenCode entries manually). Setup never writes through symlinks.

`--allow-writes` enables write tools. Direct JSON connections also need `readOnly: false`; imported connections retain their saved flag. Database grants and operator policy still apply. SSH requires a verified `known_hosts` entry by default; `HOPSQL_SSH_STRICT_HOST_KEY=false` explicitly allows unknown hosts for legacy setups.

### Native client commands

You can also register the server using your client's own CLI:

```bash
# Claude Code — available across projects
claude mcp add --transport stdio --scope user hopsql --env HOPSQL_CONFIG_FILE=/absolute/path/connections.json -- ~/.local/bin/hopsql

# Codex
codex mcp add hopsql --env HOPSQL_CONFIG_FILE=/absolute/path/connections.json -- ~/.local/bin/hopsql

# OpenCode v2 — available across projects
opencode mcp add hopsql --global -- ~/.local/bin/hopsql
```

On Windows, use `cmd /c %LOCALAPPDATA%\hopsql\bin\hopsql.cmd` as the command.

These follow the [Claude Code](https://code.claude.com/docs/en/mcp), [Codex](https://developers.openai.com/codex/mcp), and [OpenCode v2](https://opencode.ai/v2/docs/mcp-servers) registration commands. OpenCode v1 users can add a local server through their MCP settings.

### Claude Desktop and Cursor

Add the following MCP entry to Claude Desktop's `claude_desktop_config.json`, or Cursor's `mcp.json`:

```json
{
  "mcpServers": {
    "hopsql": {
      "command": "/Users/you/.local/bin/hopsql",
      "env": { "HOPSQL_CONFIG_FILE": "/absolute/path/connections.json" }
    }
  }
}
```

Use the absolute launcher path the installer prints. On Windows, use `"command": "cmd"` and `"args": ["/c", "C:\\Users\\you\\AppData\\Local\\hopsql\\bin\\hopsql.cmd"]`.

## Manage connections

Run `hopsql` (or `hopsql manage`) in a terminal to pick a connection and:

| Action | Effect |
|---|---|
| Access: read-only / ask / writable | Per-connection writes: refused, approved by you in the client one statement at a time, or allowed |
| Change access for several connections | The same, for a multi-selection |
| Set up an AWS SSM hop | Bastion by Name tag or instance ID, remote host/port, optional Secrets Manager login |
| Remove the AWS SSM hop | Back to the connection's own settings |
| Dump tools and folder | Shows the `pg_dump` / `mariadb-dump` / `mysqldump` the server will use (with versions), lets you pin one, and sets where saved dumps go |

Changes are saved to `~/.config/hopsql/overrides.json` (`HOPSQL_OVERRIDES_FILE` to move it) and apply on the next call; no restart or re-registration. They win over `overrides` in `HOPSQL_CONFIG_FILE`.

⚠️ Access set here also wins over `HOPSQL_READ_ONLY=true`, which now only covers connections left at their default. Policy-file `readOnly` rules still always apply. Write tools appear in the client's tool list as soon as any connection can take writes (the server sends `tools/list_changed`).

Bulk changes from a script or shell:

```bash
hopsql access                                # list connections and their access
hopsql access ask prod-db reporting          # by id or name
hopsql access read-only --all
hopsql access reset staging                  # back to the connection's default
```

`ask` prompts in the MCP client for each `write_query`, `create_table`, `alter_table`, `drop_table` and write statement in a transaction, showing the SQL. An approval covers that one call only. Clients that can't prompt are refused, and so is `hopsql query --write`. `hopsql exec` asks once per run instead (see below). A model that has a shell can run `hopsql access` itself, so `ask` protects against MCP-only clients, not a model with terminal access. MCP clients start Hopsql with piped stdio, so they still get the server; `hopsql serve` forces it in a terminal.

### Dumps

`dump_table` / `dump_database` find the dump client themselves: `HOPSQL_PG_DUMP_PATH` / `HOPSQL_MYSQLDUMP_PATH`, then a client pinned in `hopsql manage`, then the newest one on PATH or in the usual install folders (Homebrew `libpq`/`postgresql@N`/`mysql-client`/`mariadb`, Postgres.app, Program Files). A newer `pg_dump` can dump older servers, never the reverse.

Pass `saveToFile: true` to write the dump to a new owner-only file in the dump folder (default `~/hopsql-dumps`; `HOPSQL_DUMP_DIR` or `hopsql manage` to change) and get its path back, instead of a `read_export` handle. `fileName` picks the name; existing files are never replaced. Saved dumps are capped by `HOPSQL_DUMP_FILE_MAX_BYTES` (default 8 GiB), not the 32 MiB artifact limit.

## Command line

| Command | What it does |
|---|---|
| `hopsql query <conn> --file report.sql` | Runs one statement from a `.sql`/`.psql`/`.pgsql`/`.mysql`/`.ddl`/`.dml` file (max 1 MiB) through `execute_query`, with the same policy and JSON output. Inline SQL works too: `hopsql query <conn> "SELECT 1"` |
| `hopsql query <conn> --write --file fix.sql` | The same through `write_query`; needs `HOPSQL_READ_ONLY=false` and a writable connection |
| `hopsql exec <conn> -- psql -c 'select 1'` | Runs a local tool with the connection's credentials in its environment (`PG*` or `MYSQL_HOST`/`MYSQL_TCP_PORT`/`MYSQL_USER`/`MYSQL_PWD`, plus `DATABASE_URL`), through the same SSH/SSM tunnel |
| `hopsql doctor` | Lists the command-line tools Hopsql uses (`sqlite3`, `duckdb`, `pg_dump`, `mysqldump`/`mariadb-dump`, `aws`, `session-manager-plugin`): found with version, or missing with the install command for your OS. Tools your connections need are marked required; `--strict` exits 1 if one is missing, `--json` for scripts. The installers run it at the end |
| `hopsql update` | Checks GitHub for a newer release and reruns the installer for it (`--check` only reports, `--yes` skips the prompt, `--json` for scripts) |
| `hopsql refresh` | Recycles running MCP servers (pooled connections, tunnels and cached config dropped; the next call reconnects) and stops ones older than the installed build, so clients start the new version on reconnect. The `refresh` tool lets a model do the same. macOS and Linux |

The CLI reads the same `HOPSQL_*` variables as the server, so export `HOPSQL_CONFIG_FILE` (and any allowlist) in your shell if your MCP entry sets them.

`exec` is for PostgreSQL and MySQL/MariaDB connections. It refuses read-only connections, because raw credentials bypass Hopsql's SQL policy. On `ask` connections it asks you first, showing the connection and the full command: in the terminal when there is one, otherwise in a desktop dialog (macOS dialog, `zenity`/`kdialog` on Linux, a Windows message box). One approval covers the whole run, since Hopsql can't see the statements the command sends. With no terminal and no desktop, it refuses. Model-driven shells get piped output, so the password is masked there as `********`. It still stops accidental leaks only: a command that deliberately encodes the password could get it out.

`execute_query` and `write_query` take a `file` path instead of `query` too, so a model can run a SQL file without pasting it.

### Updates

The server checks GitHub releases at startup, at most once a day, and prints a notice on stderr when a newer one exists (`HOPSQL_UPDATE_NOTIFIER=false` turns this off). Models can call `check_for_update`, then `update_hopsql`. The latter asks you to confirm in the client before downloading anything, and refuses clients that can't ask. Updates only apply to copies installed by `install.sh`/`install.ps1`. Restart your MCP clients afterwards.

**Releasing:** bump `version` in `package.json` (and move the CHANGELOG's Unreleased notes under it) in a PR. Merging it to `main` tags `v<version>` and publishes the GitHub release, which installs then pick up. Pushing a `v*` tag by hand works too, as long as it matches `package.json`.

## One server, many instances

Register Hopsql once. Select `connectionId` in each tool call; select `database` to switch databases on PostgreSQL, MySQL/MariaDB, SQL Server, or ClickHouse. Each instance can have its own read-only setting, table policy, credentials, timeout, row/byte limits, and pool size.

Set `HOPSQL_CONFIG_FILE` to your JSON configuration, or reuse discovered workspace connections. Explicit connections default to read-only. See the [multi-instance configuration guide](docs/getting-started/configuration.md) and [access policies](docs/guides/access.md).

Large results use private, expiring handles with row and column pagination. Long cells and large exports can be read in bounded chunks. See [result paging](docs/guides/usage-examples.md#read-a-large-result-in-pages).

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HOPSQL_DISCOVER_WORKSPACE` | Include saved workspace connections | `false` with a config file; `true` otherwise |
| `HOPSQL_CONFIG_FILE` | JSON configuration for multiple database instances and their settings | Unset |
| `HOPSQL_POLICY_FILE` | Additional schema, table, function, and database access rules | Unset |
| `HOPSQL_WORKSPACE` | Path to local DB client workspace directory | OS default |
| `HOPSQL_PROJECT` | Restrict discovery to one DB client project/workspace folder | All projects |
| `HOPSQL_TIMEOUT` | Query timeout (ms) | `30000` |
| `HOPSQL_DEBUG` | Enable debug logging | `false` |
| `HOPSQL_UPDATE_NOTIFIER` | Check GitHub releases at startup and show notices on stderr | `true` |
| `HOPSQL_REPO` | GitHub repository for update checks and `hopsql update` | `kylepantall/hopsql` |
| `HOPSQL_UPDATE_GITHUB_URL` / `HOPSQL_UPDATE_RAW_URL` | Origins for release checks and installer downloads (a mirror or test fixture) | `https://github.com` / `https://raw.githubusercontent.com` |
| `HOPSQL_READ_ONLY` | Disable all write operations | `true` |
| `HOPSQL_ALLOWED_CONNECTIONS` | Comma-separated whitelist of connection IDs or names | All |
| `HOPSQL_DISABLED_TOOLS` | Comma-separated tools to disable | None |
| `HOPSQL_POOL_MIN` | Minimum connections per pool | `0` |
| `HOPSQL_POOL_MAX` | Maximum connections per pool | `4` |
| `HOPSQL_POOL_IDLE_TIMEOUT` | Idle connection timeout (ms) | `30000` |
| `HOPSQL_POOL_ACQUIRE_TIMEOUT` | Connection acquire timeout (ms) | `10000` |
| `HOPSQL_AWS_CLI_PATH` | Path to the AWS CLI (RDS IAM authentication and SSM hops) | `aws` |
| `HOPSQL_IAM_TOKEN_TIMEOUT` | Timeout for minting an RDS IAM auth token (ms) | `20000` |
| `HOPSQL_SSH_KNOWN_HOSTS` | known_hosts file used to verify SSH tunnel hosts | `~/.ssh/known_hosts` |
| `HOPSQL_SSH_STRICT_HOST_KEY` | Refuse SSH tunnel hosts with no `known_hosts` entry | `true` |
| `HOPSQL_SSH_AUTH_SOCK` | SSH agent socket or pipe; checked before `SSH_AUTH_SOCK` | Discovered |
| `HOPSQL_ARTIFACT_QUOTA_BYTES` | Disk quota for stored results, exports and dumps | `67108864` (64 MiB) |
| `HOPSQL_EXPORT_MAX_ROWS` | Row cap for streamed PostgreSQL/MySQL exports | `5000000` |
| `HOPSQL_EXPORT_MAX_BYTES` | Uncompressed byte cap for streamed exports (≤ quota) | `33554432` (32 MiB) |
| `HOPSQL_EXPORT_TIMEOUT_MS` | Timeout for a streamed export (ms) | `300000` |
| `HOPSQL_DUMP_MAX_BYTES` | Uncompressed byte cap for `dump_*` output (≤ quota) | `33554432` (32 MiB) |
| `HOPSQL_DUMP_TIMEOUT_MS` | Timeout for a dump; the client is killed after it (ms) | `600000` |
| `HOPSQL_PG_DUMP_PATH` | `pg_dump` binary for `dump_*` tools | `pg_dump` on PATH |
| `HOPSQL_MYSQLDUMP_PATH` | `mariadb-dump`/`mysqldump` binary for `dump_*` tools | PATH (`mariadb-dump` first for MariaDB) |

### Read-Only Mode

Enabled by default and blocks all write operations. The `execute_query` tool only allows SELECT, EXPLAIN, SHOW, and DESCRIBE statements. Transaction tools are disabled entirely.

```json
{
  "mcpServers": {
    "hopsql": {
      "command": "/Users/you/.local/bin/hopsql",
      "env": {
        "HOPSQL_READ_ONLY": "true"
      }
    }
  }
}
```

### Connection Whitelist

Restrict which workspace connections are visible. Accepts connection IDs or display names, comma-separated:

```json
{
  "mcpServers": {
    "hopsql": {
      "command": "/Users/you/.local/bin/hopsql",
      "env": {
        "HOPSQL_ALLOWED_CONNECTIONS": "dev-postgres,staging-mysql"
      }
    }
  }
}
```

### Disable Specific Tools

```json
{
  "mcpServers": {
    "hopsql": {
      "command": "/Users/you/.local/bin/hopsql",
      "env": {
        "HOPSQL_DISABLED_TOOLS": "drop_table,alter_table,write_query"
      }
    }
  }
}
```

## Available Tools

### Connection Management
- `list_connections` - List all database connections
- `list_databases` - Discover accessible databases on PostgreSQL, MySQL/MariaDB, SQL Server, and ClickHouse
- `get_connection_info` - Get connection details
- `test_connection` - Test connectivity

### Data Operations
- `execute_query` - Run read-only queries (SELECT, EXPLAIN, SHOW, DESCRIBE only), inline or from a `file`
- `write_query` - Run INSERT/UPDATE/DELETE, inline or from a `file`
- `export_data` - Export to CSV/JSON, with optional gzip, Brotli, or zstd
- `read_result` - Read a page of stored rows and columns
- `read_result_cell` - Read a long cell in chunks
- `read_export` - Read a stored export in bounded base64 chunks
- `dump_table` - Dump listed tables as SQL (`schemaOnly`/`dataOnly`) via `pg_dump` or `mariadb-dump`/`mysqldump`
- `dump_database` - Dump a whole database, or an include list of `tables`, the same way

PostgreSQL and MySQL/MariaDB exports stream straight to a private file, so `maxRows` can go up to `HOPSQL_EXPORT_MAX_ROWS`; results of 64 KiB or less still return inline. Other engines keep the buffered 1,000,000-row cap.

Dumps are read-only and work in read-only mode. They need the database client installed (`brew install libpq` or `brew install mariadb`/`mysql-client`; Windows: `winget install PostgreSQL.PostgreSQL` or `winget install MariaDB.Server`). They connect through SSH tunnels and the saved TLS mode, and pass passwords by environment or a private temporary option file, never argv. When a table policy applies, `dump_database` requires an explicit `tables` list. Failures return `isError` with a stable `error` code (`DUMP_TOOL_MISSING`, `DUMP_TIMEOUT`, `DUMP_OUTPUT_LIMIT`, `DUMP_FAILED`, …).

Exports support optional gzip, Brotli, and zstd downloads through `export_data.compression`. Ordinary queries remain paginated JSON. [Measured compression and media changes](docs/benchmarks/2026-10-18-compression.md).

### Schema Management
- `list_tables` - List tables and views
- `get_table_schema` - Get columns, indexes, and constraints
- `get_table_stats` - Get catalog row estimates and data/index storage
- `create_table` - Create tables
- `alter_table` - Modify tables
- `drop_table` - Drop tables (requires confirmation)

### Transactions
PostgreSQL, MySQL/MariaDB, and SQL Server support explicit transactions. Results obey the same row/byte limits and pagination as ordinary queries. Each transaction accepts one operation at a time; a failed query or changed connection/access policy rolls it back. Schema operations are excluded because some engines commit DDL implicitly. At most 32 transactions may be active or starting; idle transactions expire after one hour.

- `begin_transaction` - Start a new transaction
- `execute_in_transaction` - Execute query within a transaction
- `commit_transaction` - Commit a transaction
- `rollback_transaction` - Roll back a transaction

### Query Analysis
- `explain_query` - Analyze query execution plan
- `compare_schemas` - Compare schemas between two connections
- `get_pool_stats` - Get connection pool statistics

### Other
- `get_database_stats` - Database statistics
- `append_insight` - Store analysis notes
- `list_insights` - Retrieve stored notes
- `check_for_update` - Compare this install with the latest GitHub release
- `update_hopsql` - Install the latest release after the user confirms in the client
- `refresh` - Drop pooled connections, tunnels and cached config; recycle other servers and stop outdated ones

## Security

- **Database permissions**: use a database account with read-only grants when you require a database-level permission boundary. The SQL checks are safeguards, not a full SQL sandbox.
- **Read-only enforcement**: `execute_query` only accepts read-only statements (SELECT, EXPLAIN, SHOW, DESCRIBE, PRAGMA). Write operations must use `write_query`.
- **Query validation**: Blocks DROP DATABASE, DROP SCHEMA, TRUNCATE, DELETE/UPDATE without WHERE, GRANT, REVOKE, and user management statements.
- **Connection whitelist**: Restrict which connections are exposed via `HOPSQL_ALLOWED_CONNECTIONS`.
- **Tool filtering**: Disable any tool via `HOPSQL_DISABLED_TOOLS`.
- **Input sanitization**: Connection IDs and SQL identifiers are sanitized to prevent injection.
- **Recommendation**: For production use, also use a database-level read-only user for defense in depth.

## Workspace Format Support

Supports both configuration formats written by DBeaver-compatible DB clients:
- Legacy: XML config in `.metadata/.plugins/org.jkiss.dbeaver.core/`
- Modern: JSON config in `General/.dbeaver/`

The project/workspace folder name (`General` by default) is configurable via `HOPSQL_PROJECT`,
so workspaces using a custom or renamed DBeaver project (e.g. `DataPlatform`) are discovered
without needing to rename the project or symlink the folder.

### Connection modes

DBeaver connections are configured either **manually** (host, port, database fields) or by
**URL** (a JDBC URL). Both work. In URL mode DBeaver leaves the host/port fields at placeholder
values — usually `localhost` — and reads only the URL, so the URL is what is used here too.

### SSH tunnels

Connections that DBeaver reaches through an SSH tunnel are tunneled here as well. The tunnel is
opened on first use and reused for the lifetime of the server, with a loopback-only local
forward, and the connection's host/port are treated the way DBeaver treats them: as the database
*as seen from the SSH server*.

- Agent, password and public-key authentication are supported, taken from the connection's SSH
  tab. Credentials saved in the workspace (including the tunnel's own, stored separately from
  the database credentials) are decrypted and used.
- The SSH agent is found in this order: `HOPSQL_SSH_AUTH_SOCK`, `SSH_AUTH_SOCK`, `IdentityAgent`
  in `~/.ssh/config` (`none` disables it), then the 1Password agent socket. On Windows the
  OpenSSH agent pipe (also used by 1Password) and Pageant follow. MCP clients usually do not
  inherit your shell, so the config and 1Password fallbacks matter there. Key authentication
  also offers agent identities, and uses the agent alone when the key file is missing.
- A dropped tunnel (sleep, network change) reopens on the same local port when it is free, and
  pools are rebuilt. Read-only queries retry once after a connection-level failure; writes and
  transactions never retry.
- Bastions without public SSH can be reached over AWS SSM. DBeaver has no fields for it, so
  declare it in `HOPSQL_CONFIG_FILE`, under `overrides` (keyed by connection id or name; set
  `HOPSQL_DISCOVER_WORKSPACE=true` too) or on a configured connection. `mode: "ssh"` carries the
  first SSH hop over the session; `mode: "port-forward"` skips SSH and forwards straight to the
  database host. Needs the AWS CLI and session-manager-plugin.

```json
{
  "version": 1,
  "connections": {},
  "overrides": {
    "Reporting (prod)": {
      "ssm": { "target": "i-0123456789abcdef0", "mode": "ssh", "region": "eu-west-2", "profile": "prod" }
    }
  }
}
```

- SSH host keys must match a trusted entry in `known_hosts`; unknown hosts are refused by default.
  Verify the host fingerprint through a trusted channel before adding it.
  `HOPSQL_SSH_STRICT_HOST_KEY=false` allows unknown hosts explicitly; known-host mismatches still fail.
- If a tunnel cannot be opened the connection fails with that reason. It never falls back to
  connecting directly to the recorded host, which would reach an unrelated local database.

Table policies resolve real catalog names before checking access, including engine-specific case rules. Qualified denies also cover unqualified SQL; paged results and exports recheck permissions on every read. Restricted queries stay inside the selected database. See [access rules](docs/guides/access.md) for configuration and limits.

### VPNs

A connection can bring a VPN up before it dials, so you don't have to connect by hand. hopsql
drives your own VPN client. It checks whether the connection's first host (the outermost SSH hop,
else the database) accepts a TCP connection. If not, it starts the VPN and waits up to
`connectTimeoutMs` (default 60s) for that host. A VPN hopsql started is taken down when hopsql
exits (`disconnectOnExit: false` keeps it up).

OpenVPN Connect (macOS, Windows):

```bash
hopsql vpn import ~/Downloads/work.ovpn --name Work   # once; save credentials in the app or use an autologin profile
hopsql vpn use Work "Reporting (prod)" orders-db       # profile id or name, then connections
hopsql vpn list                                        # profiles, and which connections use a VPN
hopsql vpn clear orders-db
```

Any other client: give the argv to bring it up and down (no shell), plus an optional `check`
whose exit status 0 means "up". Set it under `overrides` or on a configured connection:

```json
"overrides": {
  "orders-db": {
    "vpn": { "provider": "command", "up": ["wg-quick", "up", "work"], "down": ["wg-quick", "down", "work"] }
  }
}
```

| ⚠️ Caveat | Why |
|---|---|
| The VPN is machine-wide | It changes routing for every app, not just hopsql |
| OpenVPN Connect holds one profile at a time | Connections that need different profiles will drop each other's VPN |
| A database that's down looks like the VPN is down | hopsql starts the VPN, then times out with a message that says so |
| Several hopsql servers share one VPN | The server that started it disconnects it when it exits |


### Querying another database on the same server

Use `list_databases` with a saved `connectionId` to discover databases accessible on a PostgreSQL, MySQL/MariaDB, SQL Server, or ClickHouse instance. Pass an optional `database` to `execute_query`, `export_data`, `dump_table`, `dump_database`, `explain_query`, `list_tables`, `get_table_schema`, `get_database_stats`, `test_connection`, or `get_pool_stats`:

```json
{"connectionId": "my-pg-server", "database": "app_logs", "query": "SELECT count(*) FROM log"}
```

The saved host, credentials, IAM, TLS, and SSH settings are reused. The saved connection is unchanged and pools remain separate for each database. The existing `connectionId: "my-pg-server/app_logs"` shorthand also works. File-backed engines such as SQLite require a separate saved connection for each file. Read-only checks and connection whitelists still apply; list a connection ID to allow its databases, or `connectionId/database` entries to restrict access to specific databases.


### Oracle

Oracle runs through `oracledb` in Thin mode, so no Oracle Client is needed. Service names, SIDs,
TNS aliases and connect descriptors are read from the connection. Rows are capped by the driver,
using a bounded ResultSet fetch. Ordinary queries reuse an isolated, bounded pool; privileged sessions remain standalone. Explicit multi-call Oracle transactions are not available.

## Custom and IAM-Authenticated Drivers

### Custom drivers

Native routing normally keys off the driver id (`postgres-jdbc`, `mysql8`). Custom drivers often use an
opaque id instead — a UUID, say — which names no engine. Those connections are resolved by falling back
to the connection's `provider` (`postgresql`, `mysql`, …) and then to the JDBC URL's sub-protocol,
including wrapped ones such as `jdbc:aws-wrapper:postgresql://…`. A custom driver wrapping a supported
engine therefore works with no extra configuration.

If an engine still cannot be identified, the resulting error names both the driver id and the provider
so you can see what was missing.

### AWS RDS IAM authentication

Connections that authenticate with an RDS IAM token instead of a stored password are detected and
handled automatically. Both shapes are recognised:

- **AWS Advanced JDBC Wrapper** drivers, which record `wrapperPlugins: "iam"` alongside `awsProfile`
  and `iamRegion`.
- The DB client's own **AWS IAM auth models**.

For these connections Hopsql:

1. Mints a token with `aws rds generate-db-auth-token` (via the AWS CLI, so SSO and role-chained
   profiles work as configured) and uses it as the password.
2. Caches each token for 13 minutes, under its 15-minute lifetime, and re-mints per physical
   connection so long-lived pools keep working.
3. Forces TLS, which RDS requires for IAM tokens.
4. Resolves the database username from the connection when present. Where it is absent, the username is
   derived from your AWS identity: either the per-developer role name (`<profile>-<user>`) or the
   assumed SSO session name.

**Requirements**: the AWS CLI on `PATH` (or `HOPSQL_AWS_CLI_PATH`), a valid session for the
connection's profile (`aws sso login --profile <profile>`), and network reachability to the endpoint.
An expired SSO session produces an error naming the profile to re-authenticate.

## Try the demo

The recording above captures a real Codex CLI session calling Hopsql tools. It uses synthetic customers and orders from the isolated `.demo/` workspace. The integration script below creates the SQLite fixtures, then checks discovery, schema inspection, queries, exports, query plans, schema comparison, and blocked writes.

```bash
bun install --frozen-lockfile
bun run build
bun run demo
```

To also test PostgreSQL database discovery, database selection, and pool identities against a temporary local cluster:

```bash
HOPSQL_DEMO_PG_BIN=/path/to/postgres/bin bun run demo -- --postgres
```

The PostgreSQL cluster binds to loopback on a temporary port, uses a random password, and is stopped and deleted after the run. The SQLite examples stay under `.demo/` so you can connect a client to them. Existing workspaces are untouched.

## Updates

Rerun the install command to update to the latest `main`, then restart your MCP client; running servers keep their current version until restarted.

Set `HOPSQL_UPDATE_NOTIFIER=true` to get a stderr notice, at most once a day, when upstream omnisql-mcp publishes a newer npm release. The check sends no database settings or credentials.

### Pulling upstream fixes

Hopsql started from omnisql-mcp commit `5eb6f78` (v3.0.0 plus docs updates) with a fresh history, so upstream changes are applied as a patch rather than merged:

```bash
git remote add upstream https://github.com/srthkdev/omnisql-mcp.git
git fetch upstream
git diff 5eb6f78 upstream/main | git apply -3
```

Resolve any conflicts, rename new `omnisql`/`OMNISQL_` references to `hopsql`/`HOPSQL_`, then record the new upstream commit here as the next base.

## Development

Bun 1.4.3 is the development runtime and package manager. Builds transpile with Bun; `bun run typecheck` remains required because transpilation does not check types. The built JavaScript also runs on Node 22.15+ and 24+.

```bash
git clone https://github.com/kylepantall/hopsql.git
cd hopsql
bun install --frozen-lockfile
bun run build
bun run test
bun run lint
```

To install your working copy instead of GitHub `main`, run `HOPSQL_SOURCE_DIR="$PWD" bash scripts/install.sh` (or set `HOPSQL_SOURCE_DIR` before `scripts/install.ps1`).

## Releases

CI builds with Bun 1.4.3, runs the Bun tests, verifies the packed server on Bun and Node.js 22/24/26, and checks dependencies. Pushing a `vX.Y.Z` tag runs the release workflow, which attaches a packed archive to a GitHub release. Nothing is published to npm. Update the version in `package.json` and the changelog first.

## License

MIT. Copyright © 2025 Sarthak Jain (omnisql-mcp) and © 2026 Kyle Pantall (Hopsql). See [LICENSE](LICENSE).
