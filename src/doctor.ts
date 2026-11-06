/**
 * `hopsql doctor [--json] [--strict]`: which external command-line tools this
 * machine has, which features need them, and how to install the missing ones.
 * A tool is required when a configured connection needs it, optional otherwise.
 * Report-only: installing database clients and the AWS CLI needs sudo and a
 * package manager that differs per OS, so the installers never do it.
 */

import { spawnSync } from 'node:child_process';
import { isIamAuthConnection, awsCliPath } from './auth/iam-auth.js';
import { clientInvocation } from './install.js';
import { resolveWindowsCommand } from './net/ssm.js';
import { dockerPath } from './net/vpn-docker.js';
import { sqlDialect } from './policy/analyzer.js';
import {
  dumpFlavorFor,
  dumpInstallHint,
  dumpToolVersion,
  resolveDumpBinary,
} from './runtime/dump.js';
import type { DatabaseConnection, DumpFlavor } from './types.js';

export interface ToolReport {
  name: string;
  /** What uses it, e.g. "SQLite connections". */
  feature: string;
  found: boolean;
  path?: string;
  version?: string;
  required: boolean;
  /** Connections that need it. */
  neededBy: string[];
  installHint?: string;
}

interface ToolSpec {
  name: string;
  feature: string;
  /** Resolved path, or a command name looked up on PATH. */
  locate: () => { path: string; version?: string } | null;
  needs: (c: DatabaseConnection) => boolean;
  hint: (platform: NodeJS.Platform) => string;
}

/** Run `command versionArg`; null when it cannot be started or fails. */
export function probe(
  command: string,
  versionArg: string,
  platform = process.platform
): { path: string; version?: string } | null {
  const resolved = platform === 'win32' ? resolveWindowsCommand(command) : command;
  let invocation;
  try {
    invocation = clientInvocation(resolved, [versionArg], platform);
  } catch {
    return null;
  }
  const result = spawnSync(invocation.command, invocation.args, {
    env: invocation.env,
    encoding: 'utf8',
    timeout: 5000,
    windowsVerbatimArguments: platform === 'win32',
  });
  if (result.error || result.status !== 0) return null;
  const version = `${result.stdout} ${result.stderr}`.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
  return { path: resolved, ...(version ? { version } : {}) };
}

function dumpTool(flavor: DumpFlavor) {
  return () => {
    try {
      // The same pick the dump tools make: env path, pinned client, then newest found.
      const binary = resolveDumpBinary(flavor);
      const version = dumpToolVersion(binary.path);
      return { path: binary.path, ...(version ? { version: version.join('.') } : {}) };
    } catch {
      return null;
    }
  };
}

const usesAws = (c: DatabaseConnection) => Boolean(c.ssm || c.awsSecret || isIamAuthConnection(c));

const by = (darwin: string, linux: string, win32: string) => (platform: NodeJS.Platform) =>
  platform === 'darwin' ? darwin : platform === 'win32' ? win32 : linux;

export const TOOLS: ToolSpec[] = [
  {
    name: 'sqlite3',
    feature: 'SQLite connections',
    locate: () => probe('sqlite3', '-version'),
    needs: (c) => sqlDialect(c.driver) === 'sqlite',
    hint: by('brew install sqlite', 'sudo apt install sqlite3', 'winget install SQLite.SQLite'),
  },
  {
    name: 'duckdb',
    feature: 'DuckDB connections (1.5.6+)',
    locate: () => probe(process.env.HOPSQL_DUCKDB_CLI || 'duckdb', '-version'),
    needs: (c) => sqlDialect(c.driver) === 'duckdb',
    hint: by(
      'brew install duckdb',
      'curl https://install.duckdb.org | sh, or set HOPSQL_DUCKDB_CLI',
      'winget install DuckDB.cli'
    ),
  },
  {
    name: 'pg_dump',
    feature: 'dump_table / dump_database on PostgreSQL',
    locate: dumpTool('postgres'),
    needs: () => false,
    hint: (platform) => dumpInstallHint('postgres', platform),
  },
  {
    name: 'mysqldump / mariadb-dump',
    feature: 'dump_table / dump_database on MySQL and MariaDB',
    locate: dumpTool('mysql'),
    needs: () => false,
    hint: (platform) => dumpInstallHint('mysql', platform),
  },
  {
    name: 'aws',
    feature: 'AWS SSM hops, RDS IAM auth and Secrets Manager logins',
    locate: () => probe(awsCliPath(), '--version'),
    needs: usesAws,
    hint: by(
      'brew install awscli',
      'see https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
      'winget install Amazon.AWSCLI'
    ),
  },
  {
    name: 'docker',
    feature: 'VPNs run in a container (vpn provider "docker")',
    locate: () => probe(dockerPath(), '--version'),
    needs: (c) => c.vpn?.provider === 'docker',
    hint: by(
      'brew install --cask docker',
      'see https://docs.docker.com/engine/install/',
      'winget install Docker.DockerDesktop'
    ),
  },
  {
    name: 'session-manager-plugin',
    feature: 'AWS SSM hops',
    locate: () => probe('session-manager-plugin', '--version'),
    needs: (c) => Boolean(c.ssm),
    hint: by(
      'brew install --cask session-manager-plugin',
      'see https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-debian-and-ubuntu.html',
      'winget install Amazon.SessionManagerPlugin'
    ),
  },
];

export function diagnose(
  connections: DatabaseConnection[],
  tools: ToolSpec[] = TOOLS,
  platform = process.platform
): ToolReport[] {
  return tools.map((tool) => {
    const located = tool.locate();
    // Dump tools are only ever optional, but say which connections could use them.
    const flavors =
      tool.name === 'pg_dump'
        ? ['postgres']
        : tool.name.includes('mysqldump')
          ? ['mysql', 'mariadb']
          : [];
    const neededBy = connections
      .filter((c) => tool.needs(c) || flavors.includes(dumpFlavorFor(c.driver) ?? ''))
      .map((c) => c.name);
    const required = connections.some((c) => tool.needs(c));
    return {
      name: tool.name,
      feature: tool.feature,
      found: located !== null,
      ...(located ?? {}),
      required,
      neededBy,
      ...(located ? {} : { installHint: tool.hint(platform) }),
    };
  });
}

/** `connectionCount` is null when the configuration could not be loaded. */
export function formatReport(reports: ToolReport[], connectionCount: number | null): string {
  const lines = ['Hopsql doctor: command-line tools', ''];
  for (const r of reports) {
    const mark = r.found ? '✓' : r.required ? '✗' : '–';
    const state = r.found
      ? `${r.version ?? 'found'}  ${r.path}`
      : r.required
        ? 'missing (required)'
        : 'not installed (optional)';
    lines.push(`${mark} ${r.name.padEnd(26)} ${state}`);
    lines.push(`    for ${r.feature}`);
    if (r.neededBy.length) lines.push(`    used by: ${r.neededBy.join(', ')}`);
    if (r.installHint) lines.push(`    install: ${r.installHint}`);
  }
  const missing = reports.filter((r) => r.required && !r.found);
  lines.push('');
  if (connectionCount === null)
    lines.push('Could not load connections, so every tool is shown as optional.');
  else if (connectionCount === 0)
    lines.push('No connections configured yet; rerun "hopsql doctor" after adding some.');
  else
    lines.push(
      missing.length
        ? `${missing.length} required tool(s) missing: ${missing.map((r) => r.name).join(', ')}.`
        : 'Every tool your connections need is installed.'
    );
  return lines.join('\n');
}

export async function runDoctor(
  args: string[],
  loadConnections: () => Promise<DatabaseConnection[]>
): Promise<number> {
  const unknown = args.find((arg) => !['--json', '--strict'].includes(arg));
  if (unknown)
    throw new Error(`Unknown option: ${unknown}. Usage: hopsql doctor [--json] [--strict]`);
  let connections: DatabaseConnection[] = [];
  let loaded = true;
  try {
    connections = await loadConnections();
  } catch {
    // A fresh install has no configuration yet; still report the tools.
    loaded = false;
  }
  const reports = diagnose(connections);
  process.stdout.write(
    (args.includes('--json')
      ? JSON.stringify({ connectionsLoaded: loaded, tools: reports })
      : formatReport(reports, loaded ? connections.length : null)) + '\n'
  );
  const missing = reports.some((r) => r.required && !r.found);
  return args.includes('--strict') && missing ? 1 : 0;
}
