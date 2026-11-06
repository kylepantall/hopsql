import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clientInvocation } from '../src/install.js';

it.skipIf(process.platform !== 'win32')(
  'runs real Windows client cmd shims with literal special characters',
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'hopsql windows '));
    try {
      fs.writeFileSync(
        join(directory, 'capture.cjs'),
        'process.stdout.write(JSON.stringify(process.argv.slice(2)))'
      );
      const shim = join(directory, 'client.cmd');
      fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0capture.cjs" %*\r\n`);
      const values = [
        'mcp',
        'add',
        '--env',
        'HOPSQL_CONFIG_FILE=C:\\My Databases\\a & b%done!.json',
        '--env',
        'HOPSQL_ALLOWED_CONNECTIONS=dev,analytics',
      ];
      const invocation = clientInvocation(shim, values);
      const result = spawnSync(invocation.command, invocation.args, {
        env: invocation.env,
        windowsVerbatimArguments: true,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(values);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'win32')(
  'install.ps1 reads a launcher that writes to stderr under Windows PowerShell 5.1',
  () => {
    const script = fs.readFileSync(join(import.meta.dir, '../scripts/install.ps1'), 'utf8');
    const helper = script.match(/^function Get-NativeOutput[\s\S]*?^}/m)?.[0];
    expect(helper).toBeDefined();
    const directory = fs.mkdtempSync(join(tmpdir(), 'hopsql ps51 '));
    try {
      // hopsql --version prints on stderr, which 5.1 turns into an error under 'Stop'.
      const launcher = join(directory, 'hopsql.cmd');
      fs.writeFileSync(launcher, '@echo off\r\necho 9.9.9 1>&2\r\n');
      const command = [
        "$ErrorActionPreference = 'Stop'",
        helper,
        `$launcher = '${launcher.replace(/'/g, "''")}'`,
        '(Get-NativeOutput { & $launcher --version }) -join " "',
      ].join('\n');
      const file = join(directory, 'probe.ps1');
      fs.writeFileSync(file, command);
      const result = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('9.9.9');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);
