/**
 * Refresh running MCP servers of this install: stop the ones still running
 * code older than the installed build (each client starts the new version on
 * reconnect), and recycle the current ones with SIGHUP (pools, tunnels and
 * caches dropped, configuration re-read). Shared by `hopsql refresh` and the
 * `refresh` tool. A stale server rejects settings a newer `hopsql` wrote.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';

export interface ServerProcess {
  pid: number;
  startedAt: Date;
}

export interface RefreshResult {
  /** Older than the installed build: stopped, reconnect to restart. */
  stopped: number[];
  /** Current: told to recycle in place. */
  recycled: number[];
  failed: number[];
}

const realpathOrNull = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};

/**
 * Servers of this install in `ps -axo pid=,lstart=,command=` output: the bare
 * entry point (`index.js` or `index.js serve`), never a CLI subcommand. ps
 * shows the path as launched (maybe through a symlink, maybe with spaces), so
 * each candidate path in the command is resolved and compared with `entry`.
 */
export function findServers(
  psOutput: string,
  entry: string,
  selfPid: number,
  resolvePath: (file: string) => string | null = realpathOrNull
): ServerProcess[] {
  const servers: ServerProcess[] = [];
  for (const line of psOutput.split('\n')) {
    // lstart is fixed-width: "Mon Nov  2 08:54:37 2026".
    const match = /^\s*(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, started, command] = match;
    const tail = /dist[\\/]index\.js(\s+serve)?\s*$/.exec(command);
    if (!tail || Number(pid) === selfPid) continue;
    const end = tail.index + tail[0].length - (tail[1]?.length ?? 0);
    const script = command.slice(0, end).trimEnd();
    // The script starts after some space; try each, longest path first.
    const ours = [...script.matchAll(/ (?=\S)/g)].some(
      (space) => resolvePath(script.slice(space.index + 1)) === entry
    );
    if (ours) servers.push({ pid: Number(pid), startedAt: new Date(started) });
  }
  return servers;
}

/** Started before the build: lstart has one-second resolution, so allow that much. */
export function isStale(server: ServerProcess, builtAt: Date): boolean {
  return server.startedAt.getTime() + 1000 < builtAt.getTime();
}

/** The installed build's entry point and when it was written. */
export function installedEntry(entry = process.argv[1]): { path: string; builtAt: Date } {
  const path = realpathSync(entry);
  return { path, builtAt: statSync(path).mtime };
}

/** Stop stale servers and recycle current ones, except `selfPid`. */
export function refreshServers(
  selfPid = process.pid,
  entry = process.argv[1],
  signal: (pid: number, name: NodeJS.Signals) => void = (pid, name) => process.kill(pid, name)
): RefreshResult {
  const result: RefreshResult = { stopped: [], recycled: [], failed: [] };
  // Windows has neither ps nor SIGHUP; only the calling server can recycle.
  if (process.platform === 'win32') return result;
  const { path, builtAt } = installedEntry(entry);
  const servers = findServers(
    execFileSync('ps', ['-axo', 'pid=,lstart=,command='], { encoding: 'utf8' }),
    path,
    selfPid
  );
  for (const server of servers) {
    const stale = isStale(server, builtAt);
    try {
      // SIGTERM runs the server's shutdown: open transactions roll back, pools close.
      signal(server.pid, stale ? 'SIGTERM' : 'SIGHUP');
      (stale ? result.stopped : result.recycled).push(server.pid);
    } catch {
      result.failed.push(server.pid);
    }
  }
  return result;
}

export const RECONNECT_HINT =
  'Reconnect hopsql in each MCP client (Claude Code: /mcp → hopsql → Reconnect) to start the installed version.';

export async function runRefresh(args: string[]): Promise<void> {
  if (args.length) throw new Error(`Unknown option: ${args[0]}. Usage: hopsql refresh`);
  if (process.platform === 'win32')
    throw new Error('hopsql refresh is not available on Windows; restart your MCP client instead.');
  const result = refreshServers();
  const say = (line: string) => process.stdout.write(line + '\n');
  say(`Recycled ${result.recycled.length} current server(s): pools, tunnels and caches reset.`);
  say(`Stopped ${result.stopped.length} outdated server(s).`);
  if (result.stopped.length) say(RECONNECT_HINT);
  if (result.failed.length) say(`Could not signal: ${result.failed.join(', ')}`);
}
