/**
 * `hopsql manage`: per-connection settings without editing JSON - read-only,
 * and the AWS SSM hop and Secrets Manager credentials a port-forward script
 * would otherwise provide. Edits go to the managed overrides file, which the
 * server reads on every connection lookup, so no client re-registration.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cancel, intro, isCancel, log, note, outro, select, text } from '@clack/prompts';
import { WorkspaceConfigParser, findWorkspaces } from './config-parser.js';
import {
  loadManagedOverrides,
  managedOverridesPath,
  parseAwsSecret,
  parseSsm,
  saveManagedOverrides,
} from './connections-config.js';
import type { ConnectionOverride, DatabaseConnection, SsmConfig } from './types.js';

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

/** One line per connection: the state that matters at a glance. */
export function describeConnection(c: DatabaseConnection): string {
  const transport = c.ssm ? `SSM ${c.ssm.mode}` : c.sshTunnel?.enabled ? 'SSH' : 'direct';
  return [
    c.name,
    c.driver,
    transport,
    c.readonly ? 'read-only' : 'writable',
    ...(c.awsSecret ? ['secret'] : []),
  ].join(' · ');
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
    if (!connections.length) {
      outro('No connections found. Save one in DBeaver, or run hopsql install.');
      return;
    }
    const chosen = answer(
      await select({
        message: 'Choose a connection',
        options: [
          ...connections.map((c) => ({ value: c.id, label: describeConnection(c) })),
          { value: '', label: 'Done' },
        ],
      })
    );
    if (!chosen) break;
    const connection = connections.find((c) => c.id === chosen)!;
    const overrides = loadManagedOverrides(file);
    const existing = overrides[connection.id] ?? {};
    const action = answer(
      await select({
        message: connection.name,
        options: [
          {
            value: 'readOnly',
            label: connection.readonly ? 'Allow writes' : 'Make read-only',
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
    let next: ConnectionOverride;
    if (action === 'readOnly') next = { ...existing, readOnly: !connection.readonly };
    else if (action === 'ssm') next = await promptSsm(connection, existing);
    else {
      next = { ...existing };
      delete next.ssm;
      delete next.awsSecret;
    }
    saveManagedOverrides({ ...overrides, [connection.id]: next }, file);
    log.success(
      action === 'readOnly'
        ? `${connection.name} is now ${next.readOnly ? 'read-only' : 'writable'}`
        : `Saved ${connection.name}`
    );
  }
  note(
    `Saved to ${file}.\nRunning servers pick changes up on the next query. ` +
      'A client registered with HOPSQL_READ_ONLY=true keeps every connection read-only.',
    'Applied'
  );
  outro('Done');
}
