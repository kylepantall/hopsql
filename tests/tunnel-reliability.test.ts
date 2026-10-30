import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Pool as PgPool } from 'pg';
import {
  SshTunnelManager,
  isConnectionLevelError,
  sshTunnelManager,
} from '../src/net/ssh-tunnel.js';
import {
  ssmArgs,
  awsInvocation,
  ssmDestinationHost,
  resolveSsmTarget,
  startSsmPortForward,
} from '../src/net/ssm.js';
import { ConnectionPoolManager } from '../src/pools/connection-pool.js';
import { WorkspaceClient } from '../src/workspace-client.js';
import { AdapterRegistry } from '../src/runtime/adapter.js';
import { decorateAwsError } from '../src/auth/iam-auth.js';
import type { DatabaseConnection } from '../src/types.js';
import { setEnv, restoreEnv } from './support/environment.js';
import {
  fixtures,
  roundTrip,
  sleep,
  startEchoServer,
  startSshServer,
} from './support/ssh-fixtures.js';

const FAKE_AWS = path.join(import.meta.dir, 'fixtures', 'fake-aws.mjs');
const f = fixtures();
afterEach(() => {
  f.run();
  restoreEnv();
});

function tunneled(id: string, sshPort: number, dbPort: number): DatabaseConnection {
  return {
    id,
    name: id,
    driver: 'postgresql',
    url: '',
    host: '127.0.0.1',
    port: dbPort,
    properties: { sslmode: 'disable' },
    sshTunnel: {
      enabled: true,
      host: '127.0.0.1',
      port: sshPort,
      user: 'anyone',
      authType: 'PASSWORD',
      password: 'anything',
    },
  };
}

/** Resolve until the manager notices the drop and hands out a new generation. */
async function nextGeneration(
  manager: SshTunnelManager,
  connection: DatabaseConnection,
  after: number
) {
  for (let i = 0; i < 50; i++) {
    const endpoint = await manager.resolveEndpoint(connection, 5432);
    if (endpoint!.generation !== after) return endpoint!;
    await sleep(50);
  }
  throw new Error('tunnel was never reopened');
}

describe('tunnel reconnect', () => {
  it('rebinds the same local port after the SSH connection drops', async () => {
    const dbPort = await startEchoServer(f);
    const ssh = await startSshServer(f);
    const manager = new SshTunnelManager();
    f.cleanups.push(() => void manager.closeAll());
    const connection = tunneled('reconnect-1', ssh.port, dbPort);

    const first = (await manager.resolveEndpoint(connection, 5432))!;
    expect(await roundTrip(first.port)).toBe('ping');

    for (const client of ssh.clients) client.end();
    const second = await nextGeneration(manager, connection, first.generation!);

    expect(second.port).toBe(first.port);
    expect(second.generation).toBeGreaterThan(first.generation!);
    expect(await roundTrip(second.port)).toBe('ping');
  }, 20000);

  it('falls back to a new port when the old one has been taken', async () => {
    const dbPort = await startEchoServer(f);
    const ssh = await startSshServer(f);
    const manager = new SshTunnelManager();
    f.cleanups.push(() => void manager.closeAll());
    const connection = tunneled('reconnect-2', ssh.port, dbPort);
    const first = (await manager.resolveEndpoint(connection, 5432))!;

    for (const client of ssh.clients) client.end();
    // Wait for the listener to be released, then squat on its port.
    const squatter = net.createServer();
    for (let i = 0; i < 50; i++) {
      const bound = await new Promise<boolean>((resolve) => {
        squatter.once('error', () => resolve(false));
        squatter.listen(first.port, '127.0.0.1', () => resolve(true));
      });
      if (bound) break;
      await sleep(50);
    }
    f.cleanups.push(() => squatter.close());
    expect(squatter.listening).toBe(true);

    const second = await nextGeneration(manager, connection, first.generation!);
    expect(second.port).not.toBe(first.port);
    expect(await roundTrip(second.port)).toBe('ping');
  }, 20000);

  it('rebuilds the pool after the tunnel is re-established', async () => {
    const dbPort = await startEchoServer(f);
    const ssh = await startSshServer(f);
    const pools = new ConnectionPoolManager();
    const connection = tunneled('reconnect-pool', ssh.port, dbPort);
    f.cleanups.push(() => {
      void pools.closeAllPools();
      void sshTunnelManager.close(connection.id);
    });

    const first = await pools.getPool(connection);
    expect(await pools.getPool(connection)).toBe(first);
    const generation = (await sshTunnelManager.resolveEndpoint(connection, 5432))!.generation!;

    for (const client of ssh.clients) client.end();
    await nextGeneration(sshTunnelManager, connection, generation);

    const second = await pools.getPool(connection);
    expect(second).not.toBe(first);
    expect((first!.pool as PgPool).ended).toBe(true);
    expect(second!.tunnelGeneration).toBeGreaterThan(generation);
  }, 20000);
});

describe('connection-level error detection', () => {
  it('recognises transport failures by code and by driver message', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ESOCKET'])
      expect(isConnectionLevelError(Object.assign(new Error('x'), { code }))).toBe(true);
    expect(isConnectionLevelError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isConnectionLevelError(new Error('x', { cause: { code: 'EPIPE' } }))).toBe(true);
  });

  it('does not treat database errors as connection loss', () => {
    expect(isConnectionLevelError(Object.assign(new Error('x'), { code: '42P01' }))).toBe(false);
    expect(isConnectionLevelError(new Error('syntax error at or near'))).toBe(false);
  });
});

describe('read-only retry on tunneled connections', () => {
  function clientWith(execute: () => Promise<unknown>) {
    const client = new WorkspaceClient(undefined, 5000);
    const calls: boolean[] = [];
    (client as unknown as { adapters: AdapterRegistry }).adapters = new AdapterRegistry([
      {
        id: 'postgres',
        capabilities: { databaseOverride: true, readOnly: 'transaction', transactions: true },
        execute: async (_c, _q, options) => {
          calls.push(options.readOnly);
          return (await execute()) as never;
        },
      },
    ]);
    return { client, calls };
  }
  const result = { columns: [], rows: [], rowCount: 0, executionTime: 0 };
  const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  const connection = {
    ...tunneled('retry', 22, 5432),
    readonly: false,
  } as DatabaseConnection;

  it('retries a read-only query once after a connection-level failure', async () => {
    let attempt = 0;
    const { client, calls } = clientWith(async () => {
      if (attempt++ === 0) throw reset();
      return result;
    });
    await client.executeQuery(connection, 'SELECT 1', { readOnly: true, trustedMetadata: true });
    expect(calls).toEqual([true, true]);
  });

  it('gives up after one retry', async () => {
    const { client, calls } = clientWith(async () => {
      throw reset();
    });
    await expect(
      client.executeQuery(connection, 'SELECT 1', { readOnly: true, trustedMetadata: true })
    ).rejects.toThrow();
    expect(calls.length).toBe(2);
  });

  it('never retries writes', async () => {
    setEnv('HOPSQL_READ_ONLY', 'false');
    const { client, calls } = clientWith(async () => {
      throw reset();
    });
    await expect(
      client.executeQuery(connection, 'UPDATE t SET a = 1', { trustedMetadata: true })
    ).rejects.toThrow();
    expect(calls).toEqual([false]);
  });

  it('does not retry direct connections or database errors', async () => {
    const direct = { ...connection, sshTunnel: undefined };
    const one = clientWith(async () => {
      throw reset();
    });
    await expect(
      one.client.executeQuery(direct, 'SELECT 1', { readOnly: true, trustedMetadata: true })
    ).rejects.toThrow();
    expect(one.calls.length).toBe(1);

    const two = clientWith(async () => {
      throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
    });
    await expect(
      two.client.executeQuery(connection, 'SELECT 1', { readOnly: true, trustedMetadata: true })
    ).rejects.toThrow();
    expect(two.calls.length).toBe(1);
  });
});

describe('SSM sessions', () => {
  const ssm = {
    target: 'i-0123456789abcdef0',
    mode: 'ssh' as const,
    region: 'eu-west-2',
    profile: 'dev',
  };

  it('builds start-session argv with no shell quoting', () => {
    const args = ssmArgs(ssm, 'AWS-StartSSHSession', { portNumber: '22' });
    expect(args.slice(0, 2)).toEqual(['ssm', 'start-session']);
    expect(args[args.indexOf('--target') + 1]).toBe(ssm.target);
    expect(args[args.indexOf('--document-name') + 1]).toBe('AWS-StartSSHSession');
    expect(args[args.indexOf('--parameters') + 1]).toBe('portNumber=22');
    expect(args[args.indexOf('--region') + 1]).toBe('eu-west-2');
    expect(args[args.indexOf('--profile') + 1]).toBe('dev');
    expect(args.some((a) => a.includes('"'))).toBe(false);
  });

  it('accepts only hostname and IP characters as the port-forward host', async () => {
    for (const host of [
      'db.internal',
      'db-1.eu-west-2.rds.amazonaws.com',
      '10.0.0.5',
      'fe80::1',
      '[::1]',
    ])
      expect(ssmDestinationHost(host)).toBe(host);
    for (const host of ['db,portNumber=22', 'db=x', 'db host', '-db', ''])
      expect(() => ssmDestinationHost(host)).toThrow();
    // Rejected before any session process is started.
    await expect(
      startSsmPortForward({ ...ssm, mode: 'port-forward' }, 'db,localPortNumber=1', 5432, 1, 100)
    ).rejects.toThrow();
  });

  it('runs a Windows .cmd shim through cmd.exe and an .exe directly', async () => {
    setEnv('HOPSQL_AWS_CLI_PATH', 'C:\\tools\\aws.cmd');
    const shim = await awsInvocation(['ssm'], 'win32');
    expect(shim.command.toLowerCase()).toContain('cmd');
    expect(shim.verbatim).toBe(true);
    setEnv('HOPSQL_AWS_CLI_PATH', 'C:\\tools\\aws.exe');
    const exe = await awsInvocation(['ssm'], 'win32');
    expect(exe).toMatchObject({ command: 'C:\\tools\\aws.exe', args: ['ssm'], verbatim: false });
  });

  // The fake CLI is a shebang script, which only POSIX can execute directly.
  it.skipIf(process.platform === 'win32')(
    'carries the first SSH hop over an ssm ssh-mode session',
    async () => {
      const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-ssm-')), 'argv');
      setEnv('HOPSQL_AWS_CLI_PATH', FAKE_AWS);
      setEnv('FAKE_AWS_LOG', log);
      const dbPort = await startEchoServer(f);
      const ssh = await startSshServer(f);
      const manager = new SshTunnelManager();
      f.cleanups.push(() => void manager.closeAll());
      const connection = { ...tunneled('ssm-ssh', ssh.port, dbPort), ssm };

      const endpoint = (await manager.resolveEndpoint(connection, 5432))!;
      expect(await roundTrip(endpoint.port)).toBe('ping');
      const argv = JSON.parse(fs.readFileSync(log, 'utf8').trim()) as string[];
      expect(argv[argv.indexOf('--document-name') + 1]).toBe('AWS-StartSSHSession');
      expect(argv[argv.indexOf('--parameters') + 1]).toBe(`portNumber=${ssh.port}`);

      // The session ending is the tunnel dying; the next resolve reopens it.
      for (const client of ssh.clients) client.end();
      const next = await nextGeneration(manager, connection, endpoint.generation!);
      expect(await roundTrip(next.port)).toBe('ping');
    },
    20000
  );

  it.skipIf(process.platform === 'win32')(
    'forwards straight to the database in port-forward mode',
    async () => {
      setEnv('HOPSQL_AWS_CLI_PATH', FAKE_AWS);
      const dbPort = await startEchoServer(f);
      const manager = new SshTunnelManager();
      f.cleanups.push(() => void manager.closeAll());
      const connection: DatabaseConnection = {
        id: 'ssm-forward',
        name: 'ssm-forward',
        driver: 'postgresql',
        url: '',
        host: '127.0.0.1',
        port: dbPort,
        ssm: { target: 'i-0123456789abcdef0', mode: 'port-forward' },
      };

      const endpoint = (await manager.resolveEndpoint(connection, 5432))!;
      expect(endpoint.host).toBe('127.0.0.1');
      expect(endpoint.port).not.toBe(dbPort);
      expect(await roundTrip(endpoint.port)).toBe('ping');

      await manager.close(connection.id);
      expect(manager.hasTunnel(connection.id)).toBe(false);
      await expect(roundTrip(endpoint.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    },
    20000
  );

  it.skipIf(process.platform === 'win32')(
    "finds the bastion by Name tag and forwards to the remote host, not DBeaver's localhost",
    async () => {
      const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-aws-'));
      f.cleanups.push(() => fs.rmSync(logDir, { recursive: true, force: true }));
      const log = path.join(logDir, 'aws.log');
      setEnv('HOPSQL_AWS_CLI_PATH', FAKE_AWS);
      setEnv('FAKE_AWS_LOG', log);
      setEnv('FAKE_AWS_INSTANCE_ID', 'i-0fa4e0002');
      const dbPort = await startEchoServer(f);
      const manager = new SshTunnelManager();
      f.cleanups.push(() => void manager.closeAll());
      const connection: DatabaseConnection = {
        id: 'ssm-tagged',
        name: 'ssm-tagged',
        driver: 'postgresql',
        url: '',
        // What a script-backed DBeaver connection records.
        host: 'localhost',
        port: 5432,
        ssm: {
          targetName: 'prod-bastion',
          mode: 'port-forward',
          remoteHost: '127.0.0.1',
          remotePort: dbPort,
        },
      };

      const endpoint = (await manager.resolveEndpoint(connection, 5432))!;
      expect(await roundTrip(endpoint.port)).toBe('ping');
      const calls = fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(calls[0].slice(0, 2)).toEqual(['ec2', 'describe-instances']);
      expect(calls[0]).toContain('Name=tag:Name,Values=prod-bastion');
      expect(calls[1][calls[1].indexOf('--target') + 1]).toBe('i-0fa4e0002');
      expect(calls[1][calls[1].indexOf('--parameters') + 1]).toContain(`portNumber=${dbPort}`);
    },
    20000
  );

  it('rejects a Name tag lookup with no running instance', async () => {
    await expect(
      resolveSsmTarget({ targetName: 'gone', mode: 'port-forward' }, async () => '\n')
    ).rejects.toThrow();
    expect(
      await resolveSsmTarget({ target: 'i-1', mode: 'ssh' }, async () => {
        throw new Error('not called');
      })
    ).toMatchObject({ target: 'i-1' });
  });

  it.skipIf(process.platform === 'win32')(
    'reports an expired SSO session the way IAM auth does',
    async () => {
      setEnv('HOPSQL_AWS_CLI_PATH', FAKE_AWS);
      setEnv('FAKE_AWS_FAIL', 'sso');
      const manager = new SshTunnelManager();
      const connection: DatabaseConnection = {
        id: 'ssm-sso',
        name: 'ssm-sso',
        driver: 'postgresql',
        url: '',
        host: 'db.internal',
        port: 5432,
        ssm: { target: 'i-0123456789abcdef0', mode: 'port-forward', profile: 'dev' },
      };
      const expected = decorateAwsError(
        new Error('Error loading SSO Token: Token for example does not exist or has expired'),
        'dev'
      );
      await expect(manager.resolveEndpoint(connection, 5432)).rejects.toThrow(expected.message);
      expect(manager.hasTunnel(connection.id)).toBe(false);
    },
    20000
  );
});
