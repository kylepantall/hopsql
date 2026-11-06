/**
 * `hopsql exec <connection> [--database <db>] -- <command> [args...]`: run a
 * local tool with a saved connection's endpoint and credentials in its
 * environment, through the same SSH/SSM tunnel the server uses. The caller
 * (often a model driving a shell) never sees the password; piped output has
 * it masked as well.
 */

import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { askUser, type Approver } from './approval.js';
import { sshTunnelManager } from './net/ssh-tunnel.js';
import { vpnManager } from './net/vpn.js';
import { dumpFlavorFor, resolveDumpTarget } from './runtime/dump.js';
import type { DatabaseConnection, DumpFlavor, DumpTarget } from './types.js';

const MASK = Buffer.from('********');

/** Client environment for a resolved target: libpq / MySQL client variables and DATABASE_URL. */
export function connectionEnv(target: DumpTarget, flavor: DumpFlavor): Record<string, string> {
  const ssl = target.ssl;
  const auth =
    encodeURIComponent(target.user) +
    (target.password ? ':' + encodeURIComponent(target.password) : '');
  const database = target.database ? '/' + encodeURIComponent(target.database) : '';
  if (flavor === 'postgres') {
    // Through a tunnel, verify-full checks the real name while dialing the loopback forward.
    const viaAddress =
      target.tunneled && ssl?.mode === 'verify-full' && target.serverName !== undefined;
    const host = viaAddress ? target.serverName! : target.host;
    const query = new URLSearchParams({
      ...(viaAddress ? { hostaddr: target.host } : {}),
      ...(ssl ? { sslmode: ssl.mode } : {}),
    }).toString();
    return {
      PGHOST: host,
      ...(viaAddress ? { PGHOSTADDR: target.host } : {}),
      PGPORT: String(target.port),
      PGUSER: target.user,
      ...(target.password ? { PGPASSWORD: target.password } : {}),
      ...(target.database ? { PGDATABASE: target.database } : {}),
      ...(ssl ? { PGSSLMODE: ssl.mode } : {}),
      ...(ssl?.ca ? { PGSSLROOTCERT: ssl.ca } : {}),
      ...(ssl?.cert ? { PGSSLCERT: ssl.cert } : {}),
      ...(ssl?.key ? { PGSSLKEY: ssl.key } : {}),
      DATABASE_URL: `postgresql://${auth}@${host}:${target.port}${database}${query ? '?' + query : ''}`,
    };
  }
  return {
    MYSQL_HOST: target.host,
    MYSQL_TCP_PORT: String(target.port),
    MYSQL_USER: target.user,
    ...(target.password ? { MYSQL_PWD: target.password } : {}),
    ...(target.database ? { MYSQL_DATABASE: target.database } : {}),
    DATABASE_URL: `${flavor === 'mariadb' ? 'mariadb' : 'mysql'}://${auth}@${target.host}:${target.port}${database}`,
  };
}

/**
 * Masks every secret in a byte stream, holding back a short tail so a secret
 * split across chunks is still caught.
 */
export function createRedactor(secrets: string[], out: Writable) {
  const needles = [...new Set(secrets.filter((s) => s.length >= 4))].map((s) => Buffer.from(s));
  const keep = Math.max(0, ...needles.map((n) => n.length - 1));
  let pending: Buffer = Buffer.alloc(0);
  const scrub = (buffer: Buffer): Buffer => {
    for (const needle of needles) {
      let index;
      while ((index = buffer.indexOf(needle)) !== -1)
        buffer = Buffer.concat([
          buffer.subarray(0, index),
          MASK,
          buffer.subarray(index + needle.length),
        ]);
    }
    return buffer;
  };
  return {
    write(chunk: Buffer) {
      pending = scrub(Buffer.concat([pending, chunk]));
      const cut = Math.max(0, pending.length - keep);
      out.write(pending.subarray(0, cut));
      pending = pending.subarray(cut);
    },
    end() {
      out.write(scrub(pending));
      pending = Buffer.alloc(0);
    },
  };
}

export interface ExecArgs {
  connectionId: string;
  database?: string;
  command: string;
  args: string[];
}

export function parseExecArgs(argv: string[]): ExecArgs {
  const usage = 'Usage: hopsql exec <connection> [--database <name>] -- <command> [args...]';
  const separator = argv.indexOf('--');
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  let connectionId: string | undefined;
  let database: string | undefined;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--database' && options[i + 1] !== undefined) database = options[++i];
    else if (!options[i].startsWith('-') && connectionId === undefined) connectionId = options[i];
    else throw new Error(usage);
  }
  if (!connectionId || command.length === 0) throw new Error(usage);
  return { connectionId, database, command: command[0], args: command.slice(1) };
}

export async function runExec(
  argv: string[],
  resolveConnection: (id: string, database?: string) => Promise<DatabaseConnection>,
  approve: Approver = askUser
): Promise<number> {
  const parsed = parseExecArgs(argv);
  const connection = await resolveConnection(parsed.connectionId, parsed.database);
  const flavor = dumpFlavorFor(connection.driver);
  if (!flavor) throw new Error('exec supports PostgreSQL and MySQL/MariaDB connections');
  if (connection.askBeforeWrite) {
    // Before any tunnel opens or token is minted. The command gets the raw
    // credentials, so this approves the whole run, not single statements.
    const shown = [parsed.command, ...parsed.args].join(' ');
    const approved = await approve(
      `Allow this command to use the credentials for "${connection.name}"?\n\n` +
        `${shown.length > 2000 ? shown.slice(0, 2000) + ' …' : shown}\n\n` +
        'It gets full access to the database for this run; Hopsql cannot check what it does.'
    );
    if (approved === null)
      throw new Error(
        'This connection asks before writes and there is no terminal or desktop dialog to ask in. Make it writable with "hopsql access writable <connection>" to use exec.'
      );
    if (!approved) throw new Error('The user did not approve this command');
  }
  const target = await resolveDumpTarget(connection, flavor);
  const injected = connectionEnv(target, flavor);
  const secrets = target.password
    ? [target.password, encodeURIComponent(target.password), injected.DATABASE_URL]
    : [];
  // Interactive terminals are the user's own; piped output (a model's shell) is masked.
  const mask = (stream: NodeJS.WriteStream) => secrets.length > 0 && !stream.isTTY;
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(parsed.command, parsed.args, {
        env: { ...process.env, ...injected },
        stdio: [
          'inherit',
          mask(process.stdout) ? 'pipe' : 'inherit',
          mask(process.stderr) ? 'pipe' : 'inherit',
        ],
      });
      for (const [source, sink] of [
        [child.stdout, process.stdout],
        [child.stderr, process.stderr],
      ] as const) {
        if (!source) continue;
        const redactor = createRedactor(secrets, sink);
        source.on('data', (chunk: Buffer) => redactor.write(chunk));
        source.on('end', () => redactor.end());
      }
      // The child owns Ctrl-C; the tunnel must outlive it.
      const ignore = () => {};
      process.on('SIGINT', ignore);
      child.once('error', (error) => {
        process.off('SIGINT', ignore);
        reject(error);
      });
      child.once('close', (code, signal) => {
        process.off('SIGINT', ignore);
        resolve(code ?? (signal ? 1 : 0));
      });
    });
  } finally {
    await sshTunnelManager.closeAll();
    await vpnManager.disconnectAll();
  }
}
