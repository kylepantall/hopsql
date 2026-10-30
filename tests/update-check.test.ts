import { setEnv, restoreEnv } from './support/environment.js';
import { describe, it, expect, vi, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkForUpdate, isNewerVersion } from '../src/update-check.js';
afterEach(() => restoreEnv());

describe('update notices', () => {
  it('compares stable versions numerically', () => {
    expect(isNewerVersion('2.2.0', '2.10.0')).toBe(true);
    expect(isNewerVersion('2.2.0', '2.2.0')).toBe(false);
    expect(isNewerVersion('2.2.0', '2.1.9')).toBe(false);
    expect(isNewerVersion('2.2.0', '3.0.0-beta.1')).toBe(false);
  });
  it('caches registry checks and notifies without touching stdout', async () => {
    setEnv('CI', '');
    setEnv('HOPSQL_UPDATE_NOTIFIER', 'true');
    const cacheDir = await mkdtemp(join(tmpdir(), 'hopsql-update-'));
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '2.3.0' })));
    const notify = vi.fn();
    try {
      await checkForUpdate('2.2.0', { cacheDir, fetch: fetcher, notify });
      await checkForUpdate('2.2.0', { cacheDir, fetch: fetcher, notify });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('2.3.0'));
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
  it('stays off unless explicitly enabled, since npm only carries upstream releases', async () => {
    setEnv('CI', '');
    setEnv('HOPSQL_UPDATE_NOTIFIER', undefined);
    const fetcher = vi.fn();
    const notify = vi.fn();
    await checkForUpdate('2.2.0', { fetch: fetcher, notify });
    expect(fetcher).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it('allows opt-out and silently tolerates network errors', async () => {
    setEnv('CI', '');
    setEnv('HOPSQL_UPDATE_NOTIFIER', 'false');
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const notify = vi.fn();
    await checkForUpdate('2.2.0', { fetch: fetcher, notify });
    expect(fetcher).not.toHaveBeenCalled();
    setEnv('HOPSQL_UPDATE_NOTIFIER', 'true');
    const cacheDir = await mkdtemp(join(tmpdir(), 'hopsql-offline-'));
    try {
      await checkForUpdate('2.2.0', { cacheDir, fetch: fetcher, notify });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
    expect(notify).not.toHaveBeenCalled();
  });
});
