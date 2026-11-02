import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
// Stable release tags only; they go into download URLs and the installer's ref.
const TAG_PATTERN = /^v?\d+\.\d+\.\d+$/;

export function isNewerVersion(current: string, latest: string): boolean {
  if (!VERSION_PATTERN.test(latest)) return false;
  const installed = current.split('-')[0].split('.').map(Number);
  const available = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (available[i] !== installed[i]) return available[i] > installed[i];
  }
  return false;
}

/** The GitHub repository releases come from; HOPSQL_REPO matches the installers. */
export function updateRepository(env = process.env): string {
  const repo = env.HOPSQL_REPO || 'kylepantall/hopsql';
  // Dot segments would walk out of /repos/ in the API and download URLs.
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    repo.split('/').some((part) => /^\.+$/.test(part))
  )
    throw new Error('Invalid HOPSQL_REPO');
  return repo;
}

export interface LatestRelease {
  version: string;
  tag: string;
  url: string;
}

export interface UpdateStatus {
  current: string;
  /** null when the repository has no stable release yet. */
  latest: LatestRelease | null;
  updateAvailable: boolean;
  command: string;
}

interface CheckOptions {
  cacheDir?: string;
  fetch?: typeof fetch;
  /** Reuse a cached answer younger than this; 0 always asks GitHub. */
  maxAgeMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Latest stable GitHub release, cached on disk so startup checks stay cheap. */
export async function fetchLatestRelease(
  options: CheckOptions = {}
): Promise<LatestRelease | null> {
  const repo = updateRepository(options.env);
  const cacheDir = options.cacheDir ?? join(homedir(), '.cache', 'hopsql');
  const cacheFile = join(cacheDir, 'update.json');
  const maxAgeMs = options.maxAgeMs ?? DAY_MS;
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (cached.repo === repo && Date.now() - cached.checkedAt < maxAgeMs) return cached.latest;
  } catch {
    /* A missing or invalid cache triggers a GitHub check. */
  }
  // The web redirect, not api.github.com: the unauthenticated API allows 60
  // requests an hour per IP, which shared office and VPN addresses exhaust.
  const response = await (options.fetch ?? fetch)(`https://github.com/${repo}/releases/latest`, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'User-Agent': 'hopsql-update-check' },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status < 300 || response.status >= 400)
    throw new Error(`GitHub release check failed (HTTP ${response.status})`);
  // With no release published, GitHub redirects to the release list instead.
  const location = response.headers.get('location') ?? '';
  const match = /\/releases\/tag\/([^/?#]+)$/.exec(location);
  let latest: LatestRelease | null = null;
  if (match) {
    const tag = decodeURIComponent(match[1]);
    const version = tag.replace(/^v/, '');
    if (!TAG_PATTERN.test(tag) || !VERSION_PATTERN.test(version))
      throw new Error('GitHub returned an unexpected release tag');
    latest = { version, tag, url: `https://github.com/${repo}/releases/tag/${tag}` };
  }
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ repo, latest, checkedAt: Date.now() }), {
      mode: 0o600,
    });
  } catch {
    /* A read-only home must not fail the check. */
  }
  return latest;
}

export async function getUpdateStatus(
  current: string,
  options: CheckOptions = {}
): Promise<UpdateStatus> {
  const latest = await fetchLatestRelease(options);
  return {
    current,
    latest,
    updateAvailable: latest !== null && isNewerVersion(current, latest.version),
    command: 'hopsql update',
  };
}

/** Best-effort notice on stderr; never delays MCP startup or writes to stdout. */
export async function checkForUpdate(
  current: string,
  options: CheckOptions & { notify?: (message: string) => void } = {}
): Promise<void> {
  const env = options.env ?? process.env;
  if (env.HOPSQL_UPDATE_NOTIFIER === 'false' || env.CI) return;
  const notify = options.notify ?? ((message: string) => console.error(message));
  try {
    const status = await getUpdateStatus(current, options);
    if (status.updateAvailable)
      notify(
        `Hopsql ${status.latest!.version} is available (installed: ${current}). Run "hopsql update" to install it. Set HOPSQL_UPDATE_NOTIFIER=false to disable notices.`
      );
  } catch {
    /* Offline checks and unwritable caches must not affect the server. */
  }
}

export interface InstallLocation {
  installDir: string;
  binDir?: string;
}

/**
 * Where install.sh / install.ps1 put this copy: `<installDir>/app/dist/index.js`.
 * Null for a source checkout or package install, which the installer does not own.
 */
export function installLocation(
  entry = process.argv[1],
  env = process.env
): InstallLocation | null {
  if (!entry) return null;
  let resolved: string;
  try {
    resolved = realpathSync(entry);
  } catch {
    return null;
  }
  const dist = dirname(resolved);
  const app = dirname(dist);
  if (basename(dist) !== 'dist' || basename(app) !== 'app') return null;
  const launcher = env.HOPSQL_LAUNCHER;
  return {
    installDir: dirname(app),
    ...(launcher && isAbsolute(launcher) ? { binDir: dirname(launcher) } : {}),
  };
}

export interface RunUpdateOptions {
  location: InstallLocation;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** 'stderr' keeps installer output off stdout, which carries the MCP protocol. */
  output?: 'inherit' | 'stderr';
}

/**
 * Rerun the installer pinned to `tag` against the existing install directory.
 * The installer builds into a staging directory and swaps it in, so a failed
 * build leaves the running install untouched. Client registrations are kept.
 */
export async function runUpdate(tag: string, options: RunUpdateOptions): Promise<void> {
  if (!TAG_PATTERN.test(tag)) throw new Error('Invalid release tag');
  const env = options.env ?? process.env;
  const repo = updateRepository(env);
  const windows = (options.platform ?? process.platform) === 'win32';
  const script = windows ? 'install.ps1' : 'install.sh';
  const response = await (options.fetch ?? fetch)(
    `https://raw.githubusercontent.com/${repo}/${tag}/scripts/${script}`,
    { signal: AbortSignal.timeout(30000) }
  );
  if (!response.ok)
    throw new Error(`Could not download the ${tag} installer (HTTP ${response.status})`);
  const directory = await mkdtemp(join(tmpdir(), 'hopsql-update-'));
  try {
    const file = join(directory, script);
    await writeFile(file, await response.text(), { mode: 0o700 });
    const [command, args] = windows
      ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-Ref', tag]]
      : ['bash', [file, tag]];
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      HOPSQL_REPO: repo,
      HOPSQL_INSTALL_DIR: options.location.installDir,
      ...(options.location.binDir ? { HOPSQL_BIN_DIR: options.location.binDir } : {}),
    };
    // A local checkout would replace the release with whatever is on disk.
    delete childEnv.HOPSQL_SOURCE_DIR;
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command, args, {
        env: childEnv,
        stdio: options.output === 'stderr' ? ['ignore', 2, 2] : 'inherit',
      });
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0) throw new Error(`Installer exited with code ${code}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
