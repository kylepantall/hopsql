# Install & connect

You need an MCP client and either an instance configuration file or a DBeaver-compatible workspace with saved, working connections. Hopsql is not published to npm; the installer builds it from GitHub with Bun 1.4.3+, downloading a private, checksum-verified Bun if needed. No clone, Node.js or sudo is required.

## Install

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/kylepantall/hopsql/main/scripts/install.sh | bash -s -- --claude
```

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/hopsql/main/scripts/install.ps1))) -Claude
```

| | macOS / Linux | Windows |
|---|---|---|
| Install directory | `~/.local/share/hopsql` | `%LOCALAPPDATA%\hopsql` |
| Launcher | `~/.local/bin/hopsql` | `%LOCALAPPDATA%\hopsql\bin\hopsql.cmd` |

`--claude` / `-Claude` registers the launcher with Claude Code (user scope). If a `hopsql` or legacy `omnisql` entry already exists, the installer leaves it alone and stops; add `--force` / `-Force` to replace it, which drops its env (allowlist, config file). Leave it out to install only. Pin a branch, tag or commit with `bash -s -- --claude <ref>` or `-Ref <ref>`; rerun the command without `--claude` / `-Claude` to update. `HOPSQL_INSTALL_DIR` and `HOPSQL_BIN_DIR` choose other directories.

## Guided setup

```bash
hopsql install
```

The installer asks you to choose a client and a connection source: direct database setup, an existing configuration file, or an optional DBeaver workspace. Direct setup accepts multiple instances, read-only settings and table rules. Credentials stay in a private configuration file or referenced environment variables; they are not placed in the client registration command. No Hopsql token is needed.

It calls the selected client's own registration command and refuses to overwrite an existing Hopsql entry. Start a new client session, then ask it to list your database connections.

## Set up one client directly

Provide an existing configuration file, or select specific saved workspace connections:

```bash
hopsql install claude --config /absolute/path/connections.json
hopsql install codex --config /absolute/path/connections.json
hopsql install opencode --config /absolute/path/connections.json
# Optional DBeaver discovery, restricted to the selected IDs:
hopsql install codex --workspace /absolute/path/workspace6 --allow reports,analytics
```

Read-only is the default. `--allow-writes` explicitly enables write tools; direct configuration entries must also set `readOnly: false`. An operator policy or database role can still deny writes. Append `--dry-run` to inspect the command. Running `install <client>` in an interactive terminal opens guided setup for that client.

The OpenCode installer uses the v2 CLI; older versions can use manual MCP configuration.

## Native registration commands

If you prefer your client's own CLI:

```bash
# Claude Code — user scope, across projects
claude mcp add --transport stdio --scope user hopsql \
  --env HOPSQL_CONFIG_FILE=/absolute/path/connections.json --env HOPSQL_READ_ONLY=true -- ~/.local/bin/hopsql

# Codex
codex mcp add hopsql --env HOPSQL_CONFIG_FILE=/absolute/path/connections.json --env HOPSQL_READ_ONLY=true \
  -- ~/.local/bin/hopsql

# OpenCode v2
opencode mcp add hopsql --global --env HOPSQL_CONFIG_FILE=/absolute/path/connections.json --env HOPSQL_READ_ONLY=true \
  -- ~/.local/bin/hopsql
```

The installed client stores its own configuration. Restart the client session after registering.

## Claude Desktop and Cursor

Add this entry to Claude Desktop's `claude_desktop_config.json`, or Cursor's `mcp.json`:

```json
{
  "mcpServers": {
    "hopsql": {
      "command": "/Users/you/.local/bin/hopsql",
      "env": {
        "HOPSQL_CONFIG_FILE": "/absolute/path/connections.json",
        "HOPSQL_READ_ONLY": "true"
      }
    }
  }
}
```

Use the absolute launcher path the installer prints. On Windows, use `"command": "cmd"` and `"args": ["/c", "C:\\Users\\you\\AppData\\Local\\hopsql\\bin\\hopsql.cmd"]`.

## Check the connection

Ask your assistant to call `list_connections`, then `test_connection` on a connection you intend to expose. If the connection is missing, check the [workspace settings](configuration.md). If authentication fails, check the configured credentials and database grants, then follow the [troubleshooting guide](../troubleshooting.md).
