/**
 * AWS Systems Manager Session Manager hops, for bastions with no public SSH.
 *
 * Both modes run `aws ssm start-session` (argv only, never a shell) and rely on
 * the session-manager-plugin the CLI launches:
 *
 *  - `ssh`: the session's stdio is the transport for the first SSH hop, as
 *    OpenSSH's `ProxyCommand aws ssm start-session ... AWS-StartSSHSession`.
 *  - `port-forward`: the plugin listens on a local port and forwards it to the
 *    database host through the instance; no SSH is involved.
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { Duplex } from 'stream';
import { awsCliPath, decorateAwsError } from '../auth/iam-auth.js';
import type { SsmConfig } from '../types.js';

const STDERR_LIMIT = 8192;
const READY_LINE = /Waiting for connections|Port \d+ opened/i;

/** Process groups still running, so a crash or exit does not orphan a plugin. */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

export interface SsmSession {
  child: ChildProcess;
  /** The AWS failure behind an early exit, decorated like IAM auth errors. */
  failure(): Error | undefined;
  /** Resolves once the child has exited, or after `waitMs`. */
  exited(waitMs: number): Promise<void>;
  kill(): void;
}

export function ssmArgs(
  ssm: SsmConfig,
  documentName: string,
  parameters: Record<string, string>
): string[] {
  return [
    'ssm',
    'start-session',
    '--target',
    ssm.target,
    '--document-name',
    documentName,
    // Shorthand rather than JSON: no quotes, so it also survives cmd.exe when
    // the CLI is a .cmd shim on Windows. Shorthand has no escaping, so callers
    // must pass values without `,` or `=` (see ssmDestinationHost).
    '--parameters',
    Object.entries(parameters)
      .map(([k, v]) => `${k}=${v}`)
      .join(','),
    ...(ssm.region ? ['--region', ssm.region] : []),
    ...(ssm.profile ? ['--profile', ssm.profile] : []),
  ];
}

function killTree(child: ChildProcess): void {
  live.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // The CLI runs the plugin as its own child; killing only the CLI leaves the
    // plugin holding the port, so signal the whole group where there is one.
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill();
  } catch {
    child.kill();
  }
}

/**
 * Resolve a bare command against PATH/PATHEXT the way Windows would, so a
 * .cmd/.bat shim can be told apart from a real executable.
 */
export function resolveWindowsCommand(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path.extname(exe)) return exe;
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs =
    exe.includes('\\') || exe.includes('/') ? [''] : (env.PATH ?? env.Path ?? '').split(';');
  for (const dir of dirs)
    for (const ext of extensions) {
      const candidate = dir ? path.join(dir, exe + ext) : exe + ext;
      if (fs.existsSync(candidate)) return candidate;
    }
  return exe;
}

/**
 * The argv to spawn the CLI with, never through a shell - except that Windows
 * can only run a .cmd/.bat through cmd.exe, which the installer's quoting
 * already handles safely.
 */
export async function awsInvocation(
  args: string[],
  platform = process.platform
): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv; verbatim: boolean }> {
  const exe = awsCliPath();
  if (platform !== 'win32') return { command: exe, args, env: process.env, verbatim: false };
  const resolved = resolveWindowsCommand(exe);
  if (!/\.(cmd|bat)$/i.test(resolved))
    return { command: resolved, args, env: process.env, verbatim: false };
  const { clientInvocation } = await import('../install.js');
  return { ...clientInvocation(resolved, args, platform), verbatim: true };
}

export async function startSsmSession(ssm: SsmConfig, args: string[]): Promise<SsmSession> {
  const exe = awsCliPath();
  const invocation = await awsInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: invocation.env,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    windowsVerbatimArguments: invocation.verbatim,
  });
  live.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const running of [...live]) killTree(running);
    });
  }

  let stderr = '';
  let spawnError: NodeJS.ErrnoException | undefined;
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk.toString();
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    spawnError = error;
  });
  const done = new Promise<void>((resolve) => {
    child.once('exit', () => {
      live.delete(child);
      resolve();
    });
    child.once('error', () => resolve());
  });

  return {
    child,
    failure() {
      if (spawnError) {
        const hint =
          spawnError.code === 'ENOENT'
            ? ` AWS CLI not found at "${exe}" - install it or set HOPSQL_AWS_CLI_PATH.`
            : '';
        return new Error(`Failed to run AWS CLI: ${spawnError.message}.${hint}`);
      }
      if (child.exitCode === null && child.signalCode === null) return undefined;
      return decorateAwsError(
        new Error(stderr.trim() || `AWS SSM session exited with code ${child.exitCode}`),
        ssm.profile
      );
    },
    exited(waitMs) {
      return Promise.race([done, new Promise<void>((r) => setTimeout(r, waitMs).unref())]);
    },
    kill: () => killTree(child),
  };
}

/** Wrap a child's stdio as the Duplex ssh2 accepts as `sock`. */
export function childStream(child: ChildProcess): Duplex {
  const stdout = child.stdout!;
  const stdin = child.stdin!;
  const stream = new Duplex({
    read() {
      stdout.resume();
    },
    write(chunk, _encoding, callback) {
      if (stdin.destroyed) callback(new Error('SSM session closed'));
      else stdin.write(chunk, callback);
    },
    final(callback) {
      stdin.end();
      callback();
    },
    destroy(error, callback) {
      killTree(child);
      callback(error);
    },
  });
  stdout.on('data', (chunk: Buffer) => {
    if (!stream.push(chunk)) stdout.pause();
  });
  stdout.once('end', () => stream.push(null));
  stdin.on('error', (error) => stream.destroy(error));
  child.once('exit', () => {
    if (!stream.destroyed) stream.push(null);
  });
  return stream;
}

/** `preferred` when it can be bound on loopback, otherwise any free port. */
export async function pickLocalPort(preferred?: number): Promise<number> {
  const attempt = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() =>
          address && typeof address === 'object' ? resolve(address.port) : reject(new Error())
        );
      });
    });
  if (preferred) {
    try {
      return await attempt(preferred);
    } catch {
      // Taken by something else since; fall back to a fresh port.
    }
  }
  return attempt(0);
}

/**
 * The database host for a port-forwarding session. It lands in the shorthand
 * `--parameters` value, where `,` or `=` would inject extra parameters, so
 * only hostname and IP address characters are accepted.
 */
export function ssmDestinationHost(host: string): string {
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(host) || host.startsWith('-'))
    throw new Error('AWS SSM port forwarding needs a plain hostname or IP address as the host');
  return host;
}

/**
 * Start a port-forwarding session and wait for the plugin to report it is
 * listening. Rejects with the decorated AWS error if the session ends first.
 */
export async function startSsmPortForward(
  ssm: SsmConfig,
  host: string,
  port: number,
  localPort: number,
  timeoutMs: number
): Promise<SsmSession> {
  const session = await startSsmSession(
    ssm,
    ssmArgs(ssm, 'AWS-StartPortForwardingSessionToRemoteHost', {
      host: ssmDestinationHost(host),
      portNumber: String(port),
      localPortNumber: String(localPort),
    })
  );
  const { child } = session;
  try {
    await new Promise<void>((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`AWS SSM port forward did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);
      const onData = (chunk: Buffer) => {
        buffered = (buffered + chunk.toString()).slice(-4096);
        if (READY_LINE.test(buffered)) {
          cleanup();
          resolve();
        }
      };
      const onEnd = () => {
        cleanup();
        // Give the exit status and stderr a moment to land before reporting.
        void session
          .exited(1000)
          .then(() => reject(session.failure() ?? new Error('AWS SSM session ended')));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        child.off('exit', onEnd);
        child.off('error', onEnd);
      };
      child.stdout?.on('data', onData);
      child.once('exit', onEnd);
      child.once('error', onEnd);
    });
  } catch (error) {
    session.kill();
    throw error;
  }
  // Keep draining output so a chatty plugin never blocks on a full pipe.
  child.stdout?.resume();
  return session;
}
