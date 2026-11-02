import { describe, expect, it } from 'bun:test';
import { findServers, isStale } from '../src/refresh.js';

const entry = '/private/home/me/hopsql/app/dist/index.js';
// ps shows paths as launched: through a symlink, or containing spaces.
const resolvePath = (file: string) =>
  ({
    [entry]: entry,
    '/home/me/hopsql/app/dist/index.js': entry,
    '/Users/Me Too/hopsql/app/dist/index.js': entry,
  })[file] ?? null;
const ps = [
  `  101 Mon Nov  2 08:54:37 2026     /bun ${entry}`,
  `  102 Mon Nov  2 13:38:08 2026     /bun /home/me/hopsql/app/dist/index.js serve`,
  `  103 Mon Nov  2 13:38:30 2026     /opt/my bun/bun /Users/Me Too/hopsql/app/dist/index.js`,
  // CLI subcommands and other installs are not servers of this install.
  `  104 Mon Nov  2 13:40:00 2026     /bun ${entry} access`,
  `  105 Mon Nov  2 13:41:00 2026     /bun /other/checkout/dist/index.js`,
  `  106 Mon Nov  2 13:42:00 2026     /bun ${entry}`,
  'garbage line',
].join('\n');

describe('hopsql refresh', () => {
  it('finds the running servers of this install, never itself or CLI commands', () => {
    const servers = findServers(ps, entry, 106, resolvePath);
    expect(servers.map((s) => s.pid)).toEqual([101, 102, 103]);
    expect(servers[0].startedAt.getHours()).toBe(8);
  });

  it('treats servers started before the build as stale, within lstart resolution', () => {
    const builtAt = new Date('Mon Nov  2 13:38:08 2026');
    const [old, current] = findServers(ps, entry, 0, resolvePath);
    expect(isStale(old, builtAt)).toBe(true);
    expect(isStale(current, builtAt)).toBe(false);
    expect(isStale({ pid: 1, startedAt: new Date(builtAt.getTime() - 900) }, builtAt)).toBe(false);
  });
});
