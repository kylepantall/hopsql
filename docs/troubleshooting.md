# Troubleshooting

Start by testing the saved connection in DBeaver. Then check the MCP client configuration, workspace path, and tool error. You do not need to decrypt or print your stored passwords to diagnose a connection.

## The server does not start

```bash
~/.local/bin/hopsql --version
```

If the command works in a terminal but fails in a desktop client, the client may not inherit your shell's PATH. Use the absolute launcher path the installer printed.

On Windows, register `cmd /c %LOCALAPPDATA%\hopsql\bin\hopsql.cmd`; clients cannot launch a `.cmd` file directly. See [install and connect](getting-started/installation.md).

## No connections are listed

Confirm that `HOPSQL_WORKSPACE` points to the workspace directory. A modern project normally contains `.dbeaver/data-sources.json` beneath that directory. It can have a name other than `General`.

If `HOPSQL_PROJECT` is set, only that project is read. An allowlist can also hide connections; compare its entries with the saved IDs or names.

Save the connection in DBeaver, then restart the MCP client session after changing configuration.

## Authentication fails

Check the connection in DBeaver and ensure its password is saved. If the password or certificate changed, save the updated settings in the workspace.

For IAM connections, verify that the AWS CLI is available to the MCP process and renew any expired SSO session for the relevant profile. For SSH-agent authentication, ensure the process has access to the intended agent.

Enable `HOPSQL_DEBUG=true` for diagnostic logs in the client's MCP server logs. Remove credentials, hostnames, and sensitive query results before attaching logs to an issue.

## The server connects to localhost unexpectedly

For JDBC URL-mode connections, use the current Hopsql release so the URL is interpreted instead of DBeaver's placeholder host fields. For SSH connections, confirm the tunnel handler is enabled and its credentials are available.

A tunnel failure should produce a tunnel error; Hopsql does not fall back to a direct local connection.

## SQLite is unavailable

Install a current `sqlite3` CLI and make it available on the MCP process's PATH. Hopsql uses JSON output and CLI safe mode. SQLite CLI dot commands and host file functions are not supported through query tools.

The database path must point to the intended file. A `database` override cannot select another SQLite file; create a separate saved connection instead.

## A query is rejected

Read-only tools accept a single read-only statement. Stacked statements and write CTEs are rejected. Some ambiguous SQL forms are rejected conservatively; simplify the query or use a suitable database view.

For permitted writes, enable the write tools deliberately and use `write_query`. Do not turn off database permissions just to get past an error.

## A feature differs across engines

SQL syntax and metadata support vary. Oracle uses pooled queries but does not support explicit multi-call Hopsql transactions. Unsupported drivers fail with an explicit error; Hopsql does not fall back to an unrelated CLI.

If you target another database, verify that it exists and the saved user has connection permission. Read the [database guide](guides/databases.md) for supported paths.

## An old version keeps appearing

Rerun the install command, then restart the MCP client. Confirm the installed version with `hopsql --version`.

## Report an issue

Include the Hopsql version, operating system, database engine, sanitized error, and a minimal reproduction. Do not include a credentials file or a production database dump.

[Open a GitHub issue](https://github.com/kylepantall/hopsql/issues)
