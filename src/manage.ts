/**
 * `hopsql manage`: per-connection settings without editing JSON - read-only,
 * and the AWS SSM hop and Secrets Manager credentials a port-forward script
 * would otherwise provide. Edits go to the managed overrides file, which the
 * server reads on every connection lookup, so no client re-registration.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  cancel,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  text,
} from '@clack/prompts';
import { WorkspaceConfigParser, findWorkspaces } from './config-parser.js';
import { isAbsolute } from 'node:path';
import {
  loadManagedOverrides,
  loadManagedSettings,
  managedOverridesPath,
  parseAwsSecret,
  parseSsm,
  saveManagedOverrides,
  saveManagedSettings,
} from './connections-config.js';
import { dumpDirectory, findDumpCandidates, type DumpCandidate } from './runtime/dump.js';
import type {
  ConnectionOverride,
  DatabaseConnection,
  DumpFlavor,
  SsmConfig,
  WriteAccess,
} from './types.js';
import { WRITE_ACCESS_MODES } from './types.js';

function answer<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('No further changes.');
    process.exit(0);
  }
  return value as T;
}

/** Profile names from the AWS CLI's config and credentials files. */
export function awsProfiles(home = homedir(), env = process.env): string[] {
  const files = [
    env.AWS_CONFIG_FILE || join(home, '.aws', 'config'),
    env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials'),
  ];
  const names = new Set<string>();
  for (const file of files) {
    let contents = '';
    try {
      contents = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // `[sso-session x]` has two words, so it never matches.
    for (const match of contents.matchAll(/^\s*\[\s*(?:profile\s+)?([^\]\s]+)\s*\]/gm))
      names.add(match[1]);
  }
  return [...names].sort();
}

export function accessOf(c: DatabaseConnection): WriteAccess {
  return c.readonly ? 'read-only' : c.askBeforeWrite ? 'ask' : 'writable';
}

/** One line per connection: the state that matters at a glance. */
export function describeConnection(c: DatabaseConnection): string {
  const transport = c.ssm ? `SSM ${c.ssm.mode}` : c.sshTunnel?.enabled ? 'SSH' : 'direct';
  return [
    c.name,
    c.driver,
    transport,
    // Only managed settings outrank a server started with HOPSQL_READ_ONLY=true.
    c.accessManaged ? accessOf(c) : `${accessOf(c)} (default)`,
    ...(c.awsSecret ? ['secret'] : []),
  ].join(' · ');
}

/**
 * Set the access mode of several connections in one write of the managed
 * file; `reset` drops the setting so the connection's own default applies.
 * Running servers read the file on every call, so this needs no restart.
 */
export function setAccess(
  connections: DatabaseConnection[],
  access: WriteAccess | 'reset',
  file = managedOverridesPath()
): void {
  const overrides = loadManagedOverrides(file);
  for (const connection of connections) {
    // Keep an existing entry keyed by name; the server matches id first, then name.
    const key =
      !overrides[connection.id] && overrides[connection.name] ? connection.name : connection.id;
    const next: ConnectionOverride = { ...overrides[key] };
    delete next.readOnly;
    if (access === 'reset') delete next.access;
    else next.access = access;
    overrides[key] = next;
  }
  saveManagedOverrides(overrides, file);
}

const ACCESS_USAGE =
  'Usage: hopsql access                                  List connections and their access\n' +
  '       hopsql access <read-only|ask|writable|reset> (<connection>... | --all)';

/** `hopsql access`: list or bulk-change connection access from scripts or a model's shell. */
export async function runAccessCommand(args: string[]): Promise<void> {
  const connections = await loadConnections();
  const say = (line: string) => process.stdout.write(line + '\n');
  if (args.length === 0) {
    for (const c of connections) say(`${c.id}\t${describeConnection(c)}`);
    return;
  }
  const [mode, ...targets] = args;
  if (![...WRITE_ACCESS_MODES, 'reset'].includes(mode) || targets.length === 0)
    throw new Error(ACCESS_USAGE);
  let chosen: DatabaseConnection[];
  if (targets.includes('--all')) {
    if (targets.length > 1) throw new Error(ACCESS_USAGE);
    chosen = connections;
  } else {
    const missing = targets.filter((t) => !connections.some((c) => c.id === t || c.name === t));
    if (missing.length)
      throw new Error(`Unknown connections: ${missing.join(', ')}. Nothing changed.`);
    chosen = connections.filter((c) => targets.includes(c.id) || targets.includes(c.name));
  }
  setAccess(chosen, mode as WriteAccess | 'reset');
  say(`${chosen.length} connection(s) set to ${mode}. Running servers apply it on the next call.`);
}

async function promptAccess(
  message: string,
  current?: WriteAccess
): Promise<WriteAccess | 'reset'> {
  return answer(
    await select<WriteAccess | 'reset'>({
      message,
      initialValue: current,
      options: [
        { value: 'read-only', label: 'Read-only', hint: 'writes refused' },
        { value: 'ask', label: 'Ask', hint: 'approve each write in the client' },
        { value: 'writable', label: 'Writable', hint: 'writes allowed' },
        { value: 'reset', label: 'Default', hint: "the connection's own setting" },
      ],
    })
  );
}

async function loadConnections(): Promise<DatabaseConnection[]> {
  const workspacePath = process.env.HOPSQL_WORKSPACE || findWorkspaces()[0];
  const parser = new WorkspaceConfigParser({ workspacePath });
  return parser.parseConnections();
}

async function promptSsm(
  connection: DatabaseConnection,
  existing: ConnectionOverride
): Promise<ConnectionOverride> {
  const current: Partial<SsmConfig> = existing.ssm ?? {};
  const by = answer(
    await select({
      message: 'How should the bastion be found?',
      initialValue: current.target ? 'target' : 'targetName',
      options: [
        {
          value: 'targetName',
          label: 'By its Name tag',
          hint: 'looked up on every connect, survives replacement',
        },
        { value: 'target', label: 'By instance ID' },
      ],
    })
  );
  const targetValue = answer(
    await text({
      message: by === 'targetName' ? 'Instance Name tag' : 'Instance ID',
      initialValue: (by === 'targetName' ? current.targetName : current.target) ?? '',
      validate: (value) => (value?.trim() ? undefined : 'Required'),
    })
  ).trim();
  const mode = answer(
    await select({
      message: 'Tunnel type',
      initialValue: current.mode ?? 'port-forward',
      options: [
        {
          value: 'port-forward',
          label: 'Port forward to the database',
          hint: 'AWS-StartPortForwardingSessionToRemoteHost',
        },
        { value: 'ssh', label: 'SSH over SSM', hint: 'uses the connection’s SSH tunnel' },
      ],
    })
  ) as SsmConfig['mode'];
  const region = answer(
    await text({
      message: 'AWS region',
      initialValue:
        current.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '',
      placeholder: 'leave empty for the profile default',
    })
  ).trim();
  const profiles = awsProfiles();
  const profile = profiles.length
    ? answer(
        await select({
          message: 'AWS profile',
          initialValue: current.profile ?? '',
          options: [
            { value: '', label: 'Default credentials' },
            ...profiles.map((name) => ({ value: name, label: name })),
          ],
        })
      )
    : answer(await text({ message: 'AWS profile', initialValue: current.profile ?? '' })).trim();
  let remoteHost = '';
  let remotePort = '';
  if (mode === 'port-forward') {
    // A localhost entry is a script's forward; the real host is beyond the bastion.
    const recorded =
      connection.host && !['localhost', '127.0.0.1', '::1'].includes(connection.host)
        ? connection.host
        : '';
    remoteHost = answer(
      await text({
        message: 'Database host, as seen from the bastion',
        initialValue: current.remoteHost ?? recorded,
        placeholder: 'leave empty to use the connection’s host',
      })
    ).trim();
    remotePort = answer(
      await text({
        message: 'Database port',
        initialValue: String(current.remotePort ?? connection.port ?? ''),
        validate: (value) =>
          !value || /^\d{1,5}$/.test(value.trim()) ? undefined : 'Enter a port number',
      })
    ).trim();
  }
  const secretId = answer(
    await text({
      message: 'Secrets Manager secret with username/password',
      initialValue: existing.awsSecret?.secretId ?? '',
      placeholder: 'leave empty to use the saved credentials',
    })
  ).trim();

  const ssm = parseSsm(
    {
      [by]: targetValue,
      mode,
      ...(region ? { region } : {}),
      ...(profile ? { profile } : {}),
      ...(remoteHost ? { remoteHost } : {}),
      ...(remotePort ? { remotePort: Number(remotePort) } : {}),
    },
    connection.name
  );
  return {
    ...(existing.readOnly === undefined ? {} : { readOnly: existing.readOnly }),
    ssm,
    ...(secretId ? { awsSecret: parseAwsSecret({ secretId }, connection.name) } : {}),
  };
}

const TOOLS: { key: 'pgDump' | 'mysqldump'; flavor: DumpFlavor; label: string }[] = [
  { key: 'pgDump', flavor: 'postgres', label: 'PostgreSQL (pg_dump)' },
  { key: 'mysqldump', flavor: 'mariadb', label: 'MySQL / MariaDB (mariadb-dump, mysqldump)' },
];

function describeCandidate(candidate: DumpCandidate): string {
  return `${candidate.name} ${candidate.version?.join('.') ?? '(unknown version)'}`;
}

/**
 * Pin the dump clients the MCP dump tools use, and the folder saved dumps go
 * to. Unpinned, the server picks the newest installed client itself.
 */
async function manageDumpTools(): Promise<void> {
  for (;;) {
    const settings = loadManagedSettings();
    const options = TOOLS.map(({ key, flavor, label }) => {
      const pinned = settings.tools?.[key];
      const best = findDumpCandidates(flavor)[0];
      const state = pinned
        ? `pinned: ${pinned}`
        : best
          ? `automatic: ${describeCandidate(best)} at ${best.path}`
          : 'not found';
      return { value: key, label, hint: state };
    });
    const choice = answer(
      await select({
        message: 'Dump tools',
        options: [
          ...options,
          { value: 'folder', label: 'Dump folder', hint: dumpDirectory() },
          { value: '', label: 'Back' },
        ],
      })
    );
    if (!choice) return;
    if (choice === 'folder') {
      const folder = answer(
        await text({
          message: 'Folder for dumps saved with saveToFile',
          initialValue: dumpDirectory(),
          validate: (value) =>
            value && isAbsolute(value.trim().replace(/^~(?=$|\/)/, homedir()))
              ? undefined
              : 'Enter an absolute path',
        })
      )
        .trim()
        .replace(/^~(?=$|\/)/, homedir());
      saveManagedSettings({ ...settings, dumpDirectory: folder });
      log.success(`Dumps will be saved to ${folder}`);
      continue;
    }
    const tool = TOOLS.find((t) => t.key === choice)!;
    const candidates = findDumpCandidates(tool.flavor);
    const picked = answer(
      await select({
        message: tool.label,
        initialValue: settings.tools?.[tool.key] ?? '',
        options: [
          { value: '', label: 'Automatic', hint: 'newest installed, found by the server' },
          ...candidates.map((c) => ({ value: c.path, label: describeCandidate(c), hint: c.path })),
          { value: '\0other', label: 'Another path…' },
        ],
      })
    );
    let path = picked;
    if (picked === '\0other')
      path = answer(
        await text({
          message: `Path to ${tool.flavor === 'postgres' ? 'pg_dump' : 'mariadb-dump or mysqldump'}`,
          validate: (value) => {
            const file = value?.trim() ?? '';
            if (!isAbsolute(file)) return 'Enter an absolute path';
            try {
              return fs.statSync(file).isFile() ? undefined : 'Not a file';
            } catch {
              return 'File not found';
            }
          },
        })
      ).trim();
    const tools = { ...settings.tools, [tool.key]: path || undefined };
    saveManagedSettings({ ...settings, tools });
    log.success(path ? `${tool.label}: using ${path}` : `${tool.label}: automatic`);
  }
}

export async function runManage(): Promise<void> {
  intro('Hopsql connections');
  const file = managedOverridesPath();
  for (;;) {
    let connections: DatabaseConnection[];
    try {
      connections = await loadConnections();
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      outro('Fix the configuration above, then run hopsql again.');
      return;
    }
    if (!connections.length)
      log.warn('No connections found. Save one in DBeaver, or run hopsql install.');
    const chosen = answer(
      await select({
        message: 'Choose a connection',
        options: [
          ...connections.map((c) => ({ value: c.id, label: describeConnection(c) })),
          ...(connections.length > 1
            ? [{ value: '\0bulk', label: 'Change access for several connections' }]
            : []),
          { value: '\0tools', label: 'Dump tools and folder' },
          { value: '', label: 'Done' },
        ],
      })
    );
    if (!chosen) break;
    if (chosen === '\0tools') {
      await manageDumpTools();
      continue;
    }
    if (chosen === '\0bulk') {
      const ids = answer(
        await multiselect({
          message: 'Connections to change (space to select)',
          options: connections.map((c) => ({ value: c.id, label: describeConnection(c) })),
          required: true,
        })
      );
      const access = await promptAccess(`Access for ${ids.length} connection(s)`);
      setAccess(
        connections.filter((c) => ids.includes(c.id)),
        access,
        file
      );
      log.success(`${ids.length} connection(s) set to ${access}`);
      continue;
    }
    const connection = connections.find((c) => c.id === chosen)!;
    const overrides = loadManagedOverrides(file);
    const existing = overrides[connection.id] ?? {};
    const action = answer(
      await select({
        message: connection.name,
        options: [
          {
            value: 'access',
            label: `Access: ${accessOf(connection)}`,
            hint: 'read-only, ask before each write, or writable',
          },
          {
            value: 'ssm',
            label: existing.ssm ? 'Edit AWS SSM hop' : 'Set up an AWS SSM hop',
            hint: 'bastion lookup, remote host, Secrets Manager login',
          },
          ...(existing.ssm || existing.awsSecret
            ? [{ value: 'removeSsm', label: 'Remove the AWS SSM hop and secret' }]
            : []),
          { value: '', label: 'Back' },
        ],
      })
    );
    if (!action) continue;
    if (action === 'access') {
      const access = await promptAccess(connection.name, accessOf(connection));
      setAccess([connection], access, file);
      log.success(`${connection.name}: ${access}`);
      continue;
    }
    let next: ConnectionOverride;
    if (action === 'ssm') next = await promptSsm(connection, existing);
    else {
      next = { ...existing };
      delete next.ssm;
      delete next.awsSecret;
    }
    saveManagedOverrides({ ...overrides, [connection.id]: next }, file);
    log.success(`Saved ${connection.name}`);
  }
  note(
    `Saved to ${file}.\nRunning servers pick changes up on the next call, no restart. ` +
      'Access set here wins over HOPSQL_READ_ONLY=true; connections left at (default) follow it.',
    'Applied'
  );
  outro('Done');
}
