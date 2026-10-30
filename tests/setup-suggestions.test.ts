import { afterEach, describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findWorkspaces, workspaceCandidates } from '../src/config-parser.js';
import { existingConfigFiles, freeConfigPath, suggestConnectionId } from '../src/install.js';

const homes: string[] = [];
const home = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopsql-suggest-'));
  homes.push(dir);
  return dir;
};
afterEach(() => homes.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('DBeaver workspace detection', () => {
  it('lists the platform locations, including Flatpak and Snap on Linux', () => {
    const linux = workspaceCandidates('linux', '/h', { XDG_DATA_HOME: '/data' });
    expect(linux[0]).toBe(path.join('/data', 'DBeaverData', 'workspace6'));
    expect(linux.some((p) => p.includes('io.dbeaver.DBeaverCommunity'))).toBe(true);
    expect(linux.some((p) => p.includes(path.join('snap', 'dbeaver-ce')))).toBe(true);
    expect(workspaceCandidates('darwin', '/h', {})).toEqual([
      path.join('/h', 'Library', 'DBeaverData', 'workspace6'),
    ]);
  });

  it('only reports workspaces that hold saved connections', () => {
    const h = home();
    const workspace = path.join(h, 'Library', 'DBeaverData', 'workspace6');
    fs.mkdirSync(path.join(workspace, 'General'), { recursive: true });
    expect(findWorkspaces('darwin', h, {})).toEqual([]);
    fs.mkdirSync(path.join(workspace, 'Custom', '.dbeaver'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'Custom', '.dbeaver', 'data-sources.json'), '{}');
    expect(findWorkspaces('darwin', h, {})).toEqual([workspace]);
  });
});

describe('setup suggestions', () => {
  it('suggests unique, valid connection IDs', () => {
    expect(suggestConnectionId('postgresql', 'orders', {})).toBe('postgresql-orders');
    expect(suggestConnectionId('sqlite', '/tmp/my data.db', {})).toBe('sqlite-my-data');
    expect(suggestConnectionId('postgresql', 'orders', { 'postgresql-orders': {} })).toBe(
      'postgresql-orders-2'
    );
  });

  it('finds existing config files, legacy ones included', () => {
    const h = home();
    expect(existingConfigFiles(h, {})).toEqual([]);
    const legacy = path.join(h, '.config', 'omnisql', 'connections.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '{}');
    expect(existingConfigFiles(h, {})).toEqual([legacy]);
  });

  it('proposes a config path that does not overwrite an existing file', () => {
    const h = home();
    const first = path.join(h, '.config', 'hopsql', 'connections.json');
    expect(freeConfigPath(h)).toBe(first);
    fs.mkdirSync(path.dirname(first), { recursive: true });
    fs.writeFileSync(first, '{}');
    expect(freeConfigPath(h)).toBe(path.join(h, '.config', 'hopsql', 'connections-2.json'));
  });
});
