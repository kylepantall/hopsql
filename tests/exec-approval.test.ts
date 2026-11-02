import { describe, expect, it, vi } from 'bun:test';
import { dialogCommands } from '../src/approval.js';
import { runExec } from '../src/exec.js';
import type { DatabaseConnection } from '../src/types.js';

const connection = (askBeforeWrite: boolean): DatabaseConnection => ({
  id: 'pg',
  name: 'Billing',
  driver: 'postgresql',
  url: '',
  host: 'exec-approval.invalid',
  port: 5432,
  user: 'svc',
  database: 'app',
  askBeforeWrite,
});
const run = (askBeforeWrite: boolean, approve: Parameters<typeof runExec>[2]) =>
  runExec(
    ['pg', '--', process.execPath, '-e', 'process.exit(5)'],
    async () => connection(askBeforeWrite),
    approve
  );

describe('hopsql exec approval', () => {
  it('asks once on ask connections, showing the connection and command', async () => {
    const approve = vi.fn().mockResolvedValue(true);
    expect(await run(true, approve)).toBe(5);
    expect(approve).toHaveBeenCalledTimes(1);
    const message = approve.mock.calls[0][0] as string;
    expect(message).toContain('Billing');
    expect(message).toContain('process.exit(5)');
  });

  it('refuses when the user declines or nobody can be asked, before running anything', async () => {
    await expect(run(true, vi.fn().mockResolvedValue(false))).rejects.toThrow();
    await expect(run(true, vi.fn().mockResolvedValue(null))).rejects.toThrow();
  });

  it('never asks on writable connections', async () => {
    const approve = vi.fn();
    expect(await run(false, approve)).toBe(5);
    expect(approve).not.toHaveBeenCalled();
  });

  it('passes the message to dialogs as data, never as script or markup', () => {
    const message = 'x" & do shell script "touch /tmp/pwned" & "<b>';
    const [mac] = dialogCommands(message, 'darwin');
    expect(mac.args.at(-1)).toBe(message);
    expect(mac.args.filter((arg) => arg.includes(message))).toHaveLength(1);
    const [windows] = dialogCommands(message, 'win32', {});
    expect(windows.env?.HOPSQL_APPROVAL_TEXT).toBe(message);
    expect(windows.args.join(' ')).not.toContain(message);
    const [zenity] = dialogCommands(message, 'linux', { DISPLAY: ':0' });
    expect(zenity.args).toContain('--no-markup');
    // No desktop session: nobody to ask.
    expect(dialogCommands(message, 'linux', {})).toEqual([]);
  });
});
