# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-11-06

### Added

- `run_script` tool: runs a multi-statement script (inline or a `.sql` file) in one transaction, so all statements commit or none do. Each statement gets the same access checks as `execute_in_transaction`, and `ask` connections approve the whole script in one prompt. DDL on tables, indexes, views, sequences and types is allowed where it rolls back (PostgreSQL, SQL Server). Functions, triggers, roles and extensions are refused.
- VPN per connection: a `vpn` setting brings your VPN up before the connection dials, if its first host is unreachable, and takes it down when hopsql exits. Supports OpenVPN Connect profiles, or any client through `up`/`down`/`check` commands.
- `hopsql vpn list | import <file.ovpn> | use <profile> <connection>... | clear <connection>...`: import OpenVPN Connect profiles and pick which connections need them.
- `docker` VPN provider (`hopsql vpn use <profile|file.ovpn> <connection>... --docker`): runs OpenVPN in a local container and dials only hopsql's connections through its SOCKS proxy, so other apps stay off the VPN. `hopsql doctor` reports Docker when a connection needs it.

### Fixed

- PostgreSQL `DO` blocks were rejected as an unsupported operation. They now run in `execute_in_transaction` and `run_script`, except on connections with access policies, where their body can't be checked.

## [1.2.0] - 2026-11-02

### Added

- `hopsql doctor [--json] [--strict]`: reports `sqlite3`, `duckdb`, `pg_dump`, `mysqldump`/`mariadb-dump`, `aws` and `session-manager-plugin` (found with version and path, or missing with an install command for this OS), marking the ones your connections need as required. The installers run it at the end and never fail on it.
- `hopsql refresh` and the `refresh` tool: recycle running servers in place (pools, tunnels, cached config) and stop ones older than the installed build, so clients start the new version on reconnect.
- `hopsql exec` on `ask` connections asks once per run, showing the connection and command: in the terminal, or a desktop dialog when a model runs it without one. It is still refused for read-only connections.
- `HOPSQL_UPDATE_GITHUB_URL` / `HOPSQL_UPDATE_RAW_URL`: point update checks and installer downloads at a mirror.
- CI covers ask approvals inside transactions (Postgres, MySQL, MariaDB, SQL Server) and the approval-gated update flow end to end.

### Fixed

- Dump client versions come from `Ver` / `Distrib`, not the last number printed (`for macos26.6` was read as the version), so the newest client is picked correctly.
- An unknown override setting now says to restart the MCP server: a server started before an update rejects settings the newer `hopsql` wrote.

## [1.1.0] - 2026-11-02

### Added

- SSM `targetName`: find the bastion by its `Name` tag on every (re)connect.
- SSM `remoteHost` / `remotePort`: port-forward to a host other than the DBeaver connection's (e.g. one that points at a script's `localhost` forward).
- `awsSecret`: read `username` / `password` from AWS Secrets Manager.
- `hopsql manage` (or bare `hopsql` in a terminal): per-connection read-only switch and AWS SSM / Secrets Manager setup, saved to `~/.config/hopsql/overrides.json`. Overrides also accept `readOnly`.
- Unknown SSH host keys can be approved from the MCP client's prompt.
- Dump tools: `saveToFile` / `fileName` write the dump straight to the dump folder (`~/hopsql-dumps`, up to `HOPSQL_DUMP_FILE_MAX_BYTES`) and return its path.
- Dump clients are found in Homebrew, Postgres.app and Program Files folders as well as PATH, newest first; `hopsql manage` can pin one and set the dump folder.
- `execute_query` / `write_query` accept a `file` (`.sql`, `.psql`, `.pgsql`, `.mysql`, `.ddl`, `.dml`; max 1 MiB) instead of `query`.
- `hopsql query <conn> (<sql> | --file <f>) [--write]`: run a statement from the terminal under the server's policy.
- `hopsql exec <conn> -- <command>`: run a local tool with the connection's credentials injected as `PG*` / `MYSQL_*` / `DATABASE_URL`, tunnel included; the password is masked in piped output. Refused for read-only connections.
- `hopsql update` and the `check_for_update` / `update_hopsql` tools: install the latest GitHub release (the tool asks the user to confirm first).

- Per-connection access `read-only` / `ask` / `writable`: `ask` has the user approve each write statement in the client. Set it with `hopsql access <mode> (<conn>... | --all)` or the bulk option in `hopsql manage`; running servers apply it on the next call and send `tools/list_changed`. Overrides accept `access` (the older `readOnly` still works).

### Changed

- ⚠️ Access set in the managed overrides file now wins over `HOPSQL_READ_ONLY=true`, which only covers connections left at their default. Policy-file `readOnly` rules still always apply.
- ⚠️ Update notices are on by default and come from this fork's GitHub releases, not upstream npm; `HOPSQL_UPDATE_NOTIFIER=false` disables them.

- ⚠️ `hopsql` with no arguments in a terminal opens the manage UI; use `hopsql serve` to run the server there.

### Fixed

- PostgreSQL `statement_timeout` is set per session, so RDS Proxy no longer rejects connections (0A000).
- High-severity audit findings in `@azure/msal-node`, `body-parser` and `zod`.

## [1.0.0] - 2026-10-30

First Hopsql release: a fork of [omnisql-mcp](https://github.com/srthkdev/omnisql-mcp) v3.0.0 (commit `5eb6f78`). For changes before the fork, see the [omnisql-mcp changelog](https://github.com/srthkdev/omnisql-mcp/blob/main/CHANGELOG.md).

### Added

- SSH tunnels follow DBeaver jump servers (`jumpServer<N>.*`), dialling each hop through the previous one and verifying every host key.
- **SSM hops**: an `ssm` block (`target`, `mode`, optional `region`/`profile`) on a configured connection, or under `overrides` for a DBeaver one, reaches bastions without public SSH. `mode: "ssh"` carries the first SSH hop over `AWS-StartSSHSession`; `mode: "port-forward"` uses `AWS-StartPortForwardingSessionToRemoteHost` with no SSH. Expired SSO sessions report the same `aws sso login` hint as IAM auth.
- **SSH agent discovery**: `HOPSQL_SSH_AUTH_SOCK`, then `SSH_AUTH_SOCK`, then `IdentityAgent` in `~/.ssh/config`, then the 1Password agent socket (Windows: the OpenSSH agent pipe, then Pageant). Key auth also offers agent identities and falls back to the agent when the key file is missing.
- `dump_table` and `dump_database` tools: SQL dumps via `pg_dump` or `mariadb-dump`/`mysqldump` into the export store (`read_export`), honouring SSH tunnels, TLS mode, table policies, byte caps and timeouts. Missing clients fail with `DUMP_TOOL_MISSING` and an install hint.
- One-command install from GitHub raw for macOS/Linux (`scripts/install.sh`) and Windows (`scripts/install.ps1`); `--claude` / `-Claude` registers it with Claude Code.

### Changed

- ⚠️ Renamed from OmniSQL: `hopsql` binary, package and MCP entry; `HOPSQL_*` settings; `hopsql:///` resource URIs; `~/.cache/hopsql` and `~/.config/hopsql`. Legacy `OMNISQL_*` variables are still read when the `HOPSQL_*` one is unset, and existing notes under `~/.cache/omnisql-mcp` are kept until a Hopsql notes folder exists. The installers replace a legacy `omnisql` Claude Code entry.
- `hopsql install <client>` registers the installed launcher, never an npm package.
- The npm update notifier is opt-in (`HOPSQL_UPDATE_NOTIFIER=true`) and reports upstream omnisql-mcp releases.
- ⚠️ A dropped SSH/SSM tunnel reopens on its previous local port when free, and pools built on the old tunnel are rebuilt. Read-only queries on tunneled connections retry once after a connection-level failure; writes never retry.
- ⚠️ PostgreSQL with no `sslmode` (or `prefer`/`allow`) now tries unverified TLS first and falls back to plaintext only if the server has no TLS, matching DBeaver/pgjdbc.
- ⚠️ `export_data` streams PostgreSQL and MySQL/MariaDB results straight to disk (with streaming compression), capped by the new `HOPSQL_EXPORT_*` settings instead of the per-response byte limit. New `HOPSQL_DUMP_*` and `HOPSQL_ARTIFACT_QUOTA_BYTES` settings.

### Removed

- npm publishing, the documentation website and its deploy workflow (docs now live in [`docs/`](docs/README.md)), and upstream graphics.
