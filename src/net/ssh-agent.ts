/**
 * Find the SSH agent socket to authenticate tunnels with.
 *
 * MCP clients often launch servers without the user's shell environment, so
 * SSH_AUTH_SOCK alone misses agents configured the way OpenSSH users actually
 * configure them - `IdentityAgent` in ~/.ssh/config, which is how the
 * 1Password agent is usually wired up.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { wildcardMatches } from './known-hosts.js';

/** The pipe Windows OpenSSH's agent listens on; 1Password's Windows agent reuses it. */
export const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

/** Named pipes cannot be probed with existsSync without side effects. */
function isNamedPipe(value: string): boolean {
  return /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(value);
}

/** Where 1Password puts its agent socket when none is configured explicitly. */
export function onePasswordAgentPaths(home = os.homedir()): string[] {
  return [
    path.join(home, 'Library', 'Group Containers', '2BUA8C4S2C.com.1password', 't', 'agent.sock'),
    path.join(home, '.1password', 'agent.sock'),
  ];
}

function expandAgentPath(value: string, home: string, env: NodeJS.ProcessEnv): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) {
    return env[value.replace(/^\$\{?|\}$/g, '')] ?? '';
  }
  return value.replace(/%d/g, home);
}

/** Split one config line into its keyword and arguments, honouring double quotes. */
function tokens(line: string): string[] {
  const out: string[] = [];
  const matcher = /"([^"]*)"|([^\s"]+)/g;
  // The keyword may be separated from its value by `=` instead of whitespace.
  const normalized = line.replace(/^(\s*\S+?)\s*=\s*/, '$1 ');
  for (const match of normalized.matchAll(matcher)) out.push(match[1] ?? match[2]);
  return out;
}

function hostMatches(patterns: string[], host: string): boolean {
  const lower = host.toLowerCase();
  if (patterns.some((p) => p.startsWith('!') && wildcardMatches(p.slice(1).toLowerCase(), lower)))
    return false;
  return patterns.some((p) => !p.startsWith('!') && wildcardMatches(p.toLowerCase(), lower));
}

/**
 * The first `IdentityAgent` that applies to `host`, as OpenSSH resolves it:
 * the first value obtained wins. `Match` blocks are skipped because evaluating
 * them needs more than a host name. Returns `none` verbatim.
 */
export function identityAgentFromConfig(contents: string, host: string): string | undefined {
  let applies = true;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [keyword, ...args] = tokens(line);
    const key = keyword?.toLowerCase();
    if (key === 'host') applies = hostMatches(args, host);
    else if (key === 'match') applies = false;
    else if (applies && key === 'identityagent' && args[0]) return args[0];
  }
  return undefined;
}

export interface AgentDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

/**
 * Locate an agent for `host`, or undefined when there is none. Only socket
 * paths that exist are returned (named pipes are taken as given);
 * `IdentityAgent none` disables agent use for the host.
 *
 * Order: HOPSQL_SSH_AUTH_SOCK, SSH_AUTH_SOCK, `IdentityAgent` in
 * ~/.ssh/config, then the 1Password default socket - or, on Windows, the
 * OpenSSH agent pipe and finally pageant.
 */
export function discoverAgentSocket(
  host: string,
  options: AgentDiscoveryOptions = {}
): string | undefined {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const exists = (candidate: string | undefined): candidate is string =>
    !!candidate && ((platform === 'win32' && isNamedPipe(candidate)) || fs.existsSync(candidate));

  for (const candidate of [env.HOPSQL_SSH_AUTH_SOCK, env.SSH_AUTH_SOCK])
    if (exists(candidate)) return candidate;

  let configured: string | undefined;
  try {
    configured = identityAgentFromConfig(
      fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf8'),
      host
    );
  } catch {
    // No readable ssh config is the common case.
  }
  if (configured?.toLowerCase() === 'none') return undefined;
  if (configured) {
    const resolved =
      configured === 'SSH_AUTH_SOCK' ? env.SSH_AUTH_SOCK : expandAgentPath(configured, home, env);
    if (exists(resolved)) return resolved;
  }

  if (platform === 'win32') {
    // Listing the pipe namespace is safe where opening a pipe is not.
    let pipes: string[] | undefined;
    try {
      pipes = fs.readdirSync('\\\\.\\pipe\\');
    } catch {
      // Unlistable: assume the standard agent pipe rather than skip it.
    }
    if (!pipes || pipes.includes('openssh-ssh-agent')) return WINDOWS_OPENSSH_AGENT_PIPE;
    return 'pageant';
  }

  for (const candidate of onePasswordAgentPaths(home)) if (exists(candidate)) return candidate;
  return undefined;
}
