import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WINDOWS_OPENSSH_AGENT_PIPE,
  discoverAgentSocket,
  identityAgentFromConfig,
  onePasswordAgentPaths,
} from '../src/net/ssh-agent.js';
import { buildConnectOptions } from '../src/net/ssh-tunnel.js';
import { setEnv, restoreEnv } from './support/environment.js';

const dirs: string[] = [];
afterEach(() => {
  restoreEnv();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A throwaway HOME, with optional ~/.ssh/config contents. */
function home(sshConfig?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-agent-'));
  dirs.push(dir);
  if (sshConfig !== undefined) {
    fs.mkdirSync(path.join(dir, '.ssh'));
    fs.writeFileSync(path.join(dir, '.ssh', 'config'), sshConfig);
  }
  return dir;
}

/** Existence is all discovery checks, so a plain file stands in for a socket. */
function socket(dir: string, ...parts: string[]): string {
  const file = path.join(dir, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

const linux = { platform: 'linux' as const };

describe('discoverAgentSocket', () => {
  it('prefers HOPSQL_SSH_AUTH_SOCK, then SSH_AUTH_SOCK', () => {
    const dir = home();
    const ours = socket(dir, 'ours.sock');
    const shell = socket(dir, 'shell.sock');
    expect(
      discoverAgentSocket('h', {
        ...linux,
        home: dir,
        env: { HOPSQL_SSH_AUTH_SOCK: ours, SSH_AUTH_SOCK: shell },
      })
    ).toBe(ours);
    expect(discoverAgentSocket('h', { ...linux, home: dir, env: { SSH_AUTH_SOCK: shell } })).toBe(
      shell
    );
  });

  it('skips env sockets that do not exist', () => {
    const dir = home();
    const onePassword = socket(
      dir,
      ...path.relative(dir, onePasswordAgentPaths(dir)[0]).split(path.sep)
    );
    expect(
      discoverAgentSocket('h', {
        ...linux,
        home: dir,
        env: { HOPSQL_SSH_AUTH_SOCK: path.join(dir, 'gone.sock') },
      })
    ).toBe(onePassword);
  });

  it('reads a quoted, tilde-relative IdentityAgent from ~/.ssh/config', () => {
    const dir = home('Host *\n  IdentityAgent "~/Library/Group Containers/agent dir/agent.sock"\n');
    const configured = socket(dir, 'Library', 'Group Containers', 'agent dir', 'agent.sock');
    expect(discoverAgentSocket('db.example.com', { ...linux, home: dir, env: {} })).toBe(
      configured
    );
  });

  it('uses the first IdentityAgent whose Host block matches', () => {
    const dir = home();
    const bastion = socket(dir, 'bastion.sock');
    const fallback = socket(dir, 'fallback.sock');
    fs.mkdirSync(path.join(dir, '.ssh'));
    fs.writeFileSync(
      path.join(dir, '.ssh', 'config'),
      `Host *.internal !skip.internal\n  IdentityAgent=${bastion}\nHost *\n  IdentityAgent ${fallback}\n`
    );
    const find = (host: string) => discoverAgentSocket(host, { ...linux, home: dir, env: {} });
    expect(find('bastion.internal')).toBe(bastion);
    expect(find('skip.internal')).toBe(fallback);
    expect(find('elsewhere.example.com')).toBe(fallback);
  });

  it('treats IdentityAgent none as no agent at all', () => {
    const dir = home('Host *\n  IdentityAgent none\n');
    socket(dir, ...path.relative(dir, onePasswordAgentPaths(dir)[0]).split(path.sep));
    expect(discoverAgentSocket('h', { ...linux, home: dir, env: {} })).toBeUndefined();
  });

  it('finds the 1Password socket when nothing else is configured', () => {
    const dir = home();
    expect(discoverAgentSocket('h', { ...linux, home: dir, env: {} })).toBeUndefined();
    const onePassword = socket(
      dir,
      ...path.relative(dir, onePasswordAgentPaths(dir)[0]).split(path.sep)
    );
    expect(discoverAgentSocket('h', { ...linux, home: dir, env: {} })).toBe(onePassword);
  });

  it('accepts Windows named pipes without probing them', () => {
    const dir = home('Host *\n  IdentityAgent \\\\.\\pipe\\custom-agent\n');
    const win = { platform: 'win32' as const, home: dir };
    expect(
      discoverAgentSocket('h', { ...win, env: { SSH_AUTH_SOCK: '\\\\.\\pipe\\from-env' } })
    ).toBe('\\\\.\\pipe\\from-env');
    expect(discoverAgentSocket('h', { ...win, env: {} })).toBe('\\\\.\\pipe\\custom-agent');
    // With nothing configured Windows lands on the OpenSSH pipe or pageant.
    const fallback = discoverAgentSocket('h', { platform: 'win32', home: home(), env: {} });
    expect([WINDOWS_OPENSSH_AGENT_PIPE, 'pageant']).toContain(fallback!);
  });
});

describe('identityAgentFromConfig', () => {
  it('ignores Match blocks and comments', () => {
    expect(
      identityAgentFromConfig('# IdentityAgent /x\nMatch host *\n  IdentityAgent /match\n', 'h')
    ).toBeUndefined();
  });
});

describe('buildConnectOptions with an agent', () => {
  const base = { enabled: true, host: 'jump', port: 22, user: 'me', authType: 'PUBLIC_KEY' };

  it('offers both the key file and the agent for key auth', () => {
    const dir = home();
    const agent = socket(dir, 'agent.sock');
    const key = path.join(dir, 'id_ed25519');
    fs.writeFileSync(key, 'key material');
    setEnv('HOPSQL_SSH_AUTH_SOCK', agent);
    const options = buildConnectOptions({ ...base, privateKeyPath: key }, 'Reporting');
    expect(options.agent).toBe(agent);
    expect(Buffer.isBuffer(options.privateKey)).toBe(true);
  });

  it('falls back to the agent when the key file is missing', () => {
    const dir = home();
    const agent = socket(dir, 'agent.sock');
    setEnv('HOPSQL_SSH_AUTH_SOCK', agent);
    const options = buildConnectOptions(
      { ...base, privateKeyPath: path.join(dir, 'missing') },
      'Reporting'
    );
    expect(options.agent).toBe(agent);
    expect(options).not.toHaveProperty('privateKey');
  });

  it('uses the discovered socket for agent auth', () => {
    const dir = home();
    const agent = socket(dir, 'agent.sock');
    setEnv('HOPSQL_SSH_AUTH_SOCK', agent);
    expect(buildConnectOptions({ ...base, authType: 'AGENT' }, 'Reporting').agent).toBe(agent);
  });
});
