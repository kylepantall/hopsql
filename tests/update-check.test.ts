import { setEnv, restoreEnv } from './support/environment.js';
import { describe, it, expect, vi, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkForUpdate,
  fetchLatestRelease,
  getUpdateStatus,
  installLocation,
  isNewerVersion,
  runUpdate,
  updateRepository,
} from '../src/update-check.js';
afterEach(() => restoreEnv());

// github.com/<repo>/releases/latest answers with a redirect to the release, or
// to the release list when none is published.
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const release = (tag: string) =>
  redirect(`https://github.com/kylepantall/hopsql/releases/tag/${encodeURIComponent(tag)}`);

async function withCache<T>(run: (cacheDir: string) => Promise<T>): Promise<T> {
  const cacheDir = await mkdtemp(join(tmpdir(), 'hopsql-update-'));
  try {
    return await run(cacheDir);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

describe('update checks', () => {
  it('compares stable versions numerically', () => {
    expect(isNewerVersion('2.2.0', '2.10.0')).toBe(true);
    expect(isNewerVersion('2.2.0', '2.2.0')).toBe(false);
    expect(isNewerVersion('2.2.0', '2.1.9')).toBe(false);
    expect(isNewerVersion('2.2.0', '3.0.0-beta.1')).toBe(false);
  });

  it('reads the latest GitHub release of the configured repository and caches it', async () => {
    await withCache(async (cacheDir) => {
      const fetcher = vi.fn().mockImplementation(async () => release('v1.2.0'));
      const env = { HOPSQL_REPO: 'someone/fork' };
      const first = await getUpdateStatus('1.0.0', { cacheDir, fetch: fetcher, env });
      const second = await getUpdateStatus('1.0.0', { cacheDir, fetch: fetcher, env });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0][0]).toBe('https://github.com/someone/fork/releases/latest');
      expect(first).toEqual(second);
      expect(first.updateAvailable).toBe(true);
      expect(first.latest).toMatchObject({ version: '1.2.0', tag: 'v1.2.0' });
    });
  });

  it('asks GitHub again when the cache belongs to another repository or maxAgeMs is 0', async () => {
    await withCache(async (cacheDir) => {
      const fetcher = vi.fn().mockImplementation(async () => release('v1.0.0'));
      await fetchLatestRelease({ cacheDir, fetch: fetcher, env: { HOPSQL_REPO: 'a/one' } });
      await fetchLatestRelease({ cacheDir, fetch: fetcher, env: { HOPSQL_REPO: 'b/two' } });
      await fetchLatestRelease({
        cacheDir,
        fetch: fetcher,
        env: { HOPSQL_REPO: 'b/two' },
        maxAgeMs: 0,
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
    });
  });

  it('reports no release when the repository has none yet', async () => {
    await withCache(async (cacheDir) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(redirect('https://github.com/kylepantall/hopsql/releases'));
      const status = await getUpdateStatus('1.0.0', { cacheDir, fetch: fetcher, env: {} });
      expect(status.latest).toBeNull();
      expect(status.updateAvailable).toBe(false);
    });
  });

  it('rejects failed checks and tags the installer would not accept', async () => {
    await withCache(async (cacheDir) => {
      for (const status of [200, 404, 429, 500]) {
        const failed = vi.fn().mockResolvedValue(new Response('', { status }));
        await expect(fetchLatestRelease({ cacheDir, fetch: failed, env: {} })).rejects.toThrow();
      }
      const odd = vi.fn().mockImplementation(async () => release('v1.0.0;rm'));
      await expect(fetchLatestRelease({ cacheDir, fetch: odd, env: {} })).rejects.toThrow();
    });
    expect(() => updateRepository({ HOPSQL_REPO: '../evil' })).toThrow();
  });

  it('notifies on stderr by default and stays quiet when disabled or offline', async () => {
    await withCache(async (cacheDir) => {
      const fetcher = vi.fn().mockImplementation(async () => release('v2.0.0'));
      const notify = vi.fn();
      await checkForUpdate('1.0.0', { cacheDir, fetch: fetcher, notify, env: {} });
      expect(notify).toHaveBeenCalledOnce();

      const silenced = vi.fn();
      await checkForUpdate('1.0.0', {
        cacheDir,
        fetch: fetcher,
        notify: silenced,
        env: { HOPSQL_UPDATE_NOTIFIER: 'false' },
      });
      await checkForUpdate('1.0.0', {
        cacheDir,
        fetch: fetcher,
        notify: silenced,
        env: { CI: '1' },
      });
      expect(silenced).not.toHaveBeenCalled();
    });
    await withCache(async (cacheDir) => {
      const offline = vi.fn().mockRejectedValue(new Error('offline'));
      const notify = vi.fn();
      await checkForUpdate('1.0.0', { cacheDir, fetch: offline, notify, env: {} });
      expect(notify).not.toHaveBeenCalled();
    });
  });

  it('recognises installer-managed copies only', () => {
    const root = mkdtempSync(join(tmpdir(), 'hopsql-install-'));
    try {
      mkdirSync(join(root, 'app', 'dist'), { recursive: true });
      const entry = join(root, 'app', 'dist', 'index.js');
      writeFileSync(entry, '');
      const location = installLocation(entry, { HOPSQL_LAUNCHER: join(root, 'bin', 'hopsql') });
      expect(location?.binDir).toBe(join(root, 'bin'));
      expect(location?.installDir).toBe(realpathSync(root));

      mkdirSync(join(root, 'checkout', 'dist'), { recursive: true });
      const checkout = join(root, 'checkout', 'dist', 'index.js');
      writeFileSync(checkout, '');
      expect(installLocation(checkout, {})).toBeNull();
      expect(installLocation(join(root, 'missing.js'), {})).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses unsafe tags before downloading anything', async () => {
    const fetcher = vi.fn();
    await expect(
      runUpdate('v1.0.0 && curl', { location: { installDir: '/tmp/x' }, fetch: fetcher })
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops when the installer cannot be downloaded', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    await expect(
      runUpdate('v1.0.0', { location: { installDir: '/tmp/x' }, fetch: fetcher, env: {} })
    ).rejects.toThrow();
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://raw.githubusercontent.com/kylepantall/hopsql/v1.0.0/scripts/install.sh'
    );
  });

  it('runs the downloaded installer with the existing install directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hopsql-run-update-'));
    try {
      const record = join(root, 'record');
      // A stand-in installer that records its arguments and environment.
      const script = `printf '%s|%s|%s|%s' "$1" "$HOPSQL_INSTALL_DIR" "$HOPSQL_BIN_DIR" "\${HOPSQL_SOURCE_DIR:-unset}" > ${JSON.stringify(record)}`;
      const fetcher = vi.fn().mockResolvedValue(new Response(script));
      setEnv('HOPSQL_SOURCE_DIR', '/somewhere');
      await runUpdate('v1.2.0', {
        location: { installDir: join(root, 'install'), binDir: join(root, 'bin') },
        fetch: fetcher,
        platform: 'darwin',
        output: 'stderr',
      });
      expect(readFileSync(record, 'utf8').split('|')).toEqual([
        'v1.2.0',
        join(root, 'install'),
        join(root, 'bin'),
        'unset',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
