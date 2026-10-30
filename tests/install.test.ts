import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, mock, afterEach } from 'bun:test';
mock.module('node:child_process', () => ({ spawnSync: vi.fn() }));
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildInstallCommand,
  clientInvocation,
  installClient,
  selfLaunch,
} from '../src/install.js';

afterEach(() => vi.restoreAllMocks());

describe('MCP client registration', () => {
  // The fork is unpublished, so it registers the running install, never npm.
  const launch = selfLaunch();

  it('registers the install.sh launcher when one is exported', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'hopsql-launcher-'));
    const launcher = join(dir, 'hopsql');
    fs.writeFileSync(launcher, '');
    const saved = process.env.HOPSQL_LAUNCHER;
    process.env.HOPSQL_LAUNCHER = launcher;
    try {
      expect(buildInstallCommand('claude').args.slice(-1)).toEqual([launcher]);
    } finally {
      if (saved === undefined) delete process.env.HOPSQL_LAUNCHER;
      else process.env.HOPSQL_LAUNCHER = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wraps the install.ps1 .cmd launcher in cmd so Windows can spawn it', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'hopsql-launcher-'));
    const launcher = join(dir, 'hopsql.cmd');
    fs.writeFileSync(launcher, '');
    const saved = process.env.HOPSQL_LAUNCHER;
    process.env.HOPSQL_LAUNCHER = launcher;
    try {
      expect(selfLaunch()).toEqual(['cmd', '/c', launcher]);
    } finally {
      if (saved === undefined) delete process.env.HOPSQL_LAUNCHER;
      else process.env.HOPSQL_LAUNCHER = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a relative launcher and runs its own entry point instead of npm', () => {
    const saved = process.env.HOPSQL_LAUNCHER;
    process.env.HOPSQL_LAUNCHER = 'hopsql';
    try {
      const [runtime, entry] = selfLaunch();
      expect(runtime).toBe(process.execPath);
      expect(isAbsolute(entry)).toBe(true);
      expect(selfLaunch()).not.toContain('omnisql-mcp@latest');
    } finally {
      if (saved === undefined) delete process.env.HOPSQL_LAUNCHER;
      else process.env.HOPSQL_LAUNCHER = saved;
    }
  });
  it.each([
    [
      'claude',
      ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'hopsql', '--', ...launch],
    ],
    ['codex', ['mcp', 'add', 'hopsql', '--', ...launch]],
    ['opencode', ['mcp', 'add', 'hopsql', '--global', '--', ...launch]],
  ])('uses the native %s registration command', (client, args) => {
    expect(buildInstallCommand(client)).toEqual({ command: client, args });
  });

  it.each(['claude', 'codex', 'opencode'])(
    'passes read-only settings to %s before the server command',
    (client) => {
      const { args } = buildInstallCommand(client, true);
      expect(args.indexOf('--env')).toBeLessThan(args.indexOf('--'));
      expect(args).toContain('HOPSQL_READ_ONLY=true');
      if (client === 'claude')
        expect(args.indexOf('--env')).toBeGreaterThan(args.indexOf('hopsql'));
    }
  );

  it('does not invoke clients for dry runs or invalid options', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    spawnSync.mockClear();
    installClient(['claude', '--dry-run']);
    expect(() => installClient(['claude', '--unknown'])).toThrow(/Supported install options/);
    expect(() => installClient(['unknown'])).toThrow(/Choose a client/);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('reports missing clients and failed registrations', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    spawnSync.mockReturnValue({
      error: Object.assign(new Error('missing'), { code: 'ENOENT' }),
    } as never);
    expect(() =>
      installClient(['codex'], {
        HOPSQL_WORKSPACE: tmpdir(),
        HOPSQL_ALLOWED_CONNECTIONS: 'fixture',
      })
    ).toThrow(/not on PATH/);
    spawnSync.mockReturnValue({ status: 1 } as never);
    expect(() =>
      installClient(['codex'], {
        HOPSQL_WORKSPACE: tmpdir(),
        HOPSQL_ALLOWED_CONNECTIONS: 'fixture',
      })
    ).toThrow(/exit 1/);
  });
});

describe('installer environment', () => {
  it('keeps workspace paths and allowlists as individual arguments', () => {
    const { args } = buildInstallCommand('claude', false, {
      HOPSQL_WORKSPACE: '/Users/test/My Databases/workspace6',
      HOPSQL_ALLOWED_CONNECTIONS: 'dev,staging',
    });
    expect(args).toContain('HOPSQL_WORKSPACE=/Users/test/My Databases/workspace6');
    expect(args).toContain('HOPSQL_ALLOWED_CONNECTIONS=dev,staging');
  });
});

describe('safe registration settings', () => {
  it('defaults to read-only and requires an explicit write opt-in', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const safe = vi.spyOn(console, 'error');
    installClient(['codex', '--dry-run']);
    expect(safe.mock.calls.flat().join(' ')).toContain('HOPSQL_READ_ONLY=true');
    safe.mockClear();
    installClient(['codex', '--allow-writes', '--dry-run']);
    expect(safe.mock.calls.flat().join(' ')).toContain('HOPSQL_READ_ONLY=false');
  });
  it('does not accept secret-bearing environment settings', () => {
    expect(() => buildInstallCommand('codex', true, { DATABASE_PASSWORD: randomUUID() })).toThrow(
      /setup settings only/
    );
  });
  it('keeps Windows shim arguments out of command source', () => {
    const arg = 'HOPSQL_CONFIG_FILE=C:\\My Databases\\a & b%done!.json';
    const invocation = clientInvocation('codex.cmd', [arg], 'win32');
    expect(invocation.command).toMatch(/cmd(?:\.exe)?$/i);
    expect(invocation.args).toContain('/v:off');
    expect(invocation.args.at(-1)).not.toContain('My Databases');
    expect(invocation.env.HOPSQL_INSTALL_ARG_1).toBe(arg);
    expect(() => clientInvocation('codex.cmd', ['injected" & whoami'], 'win32')).toThrow(/quotes/);
  });
});

it('rejects conflicting setup sources and unknown configured allowlist IDs', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() =>
    installClient(['codex', '--config', '/unused', '--workspace', '/unused', '--dry-run'])
  ).toThrow(/either --config or --workspace/);
  const directory = fs.mkdtempSync(join(tmpdir(), 'hopsql-install-flags-'));
  try {
    const file = join(directory, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        connections: { analytics: { driver: 'sqlite', database: '/unused.db' } },
      }),
      { mode: 0o600 }
    );
    expect(() =>
      installClient(['codex', '--config', file, '--allow', 'typo', '--dry-run'])
    ).toThrow(/configured connection ID/);
    expect(() =>
      installClient(['codex', '--config', file, '--allow', 'analytics,', '--dry-run'])
    ).toThrow(/configured connection ID/);
    expect(() =>
      installClient(['codex', '--config', file, '--allow', 'analytics/reporting', '--dry-run'])
    ).not.toThrow();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
