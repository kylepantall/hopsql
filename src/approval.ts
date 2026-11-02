/**
 * Ask the person at this machine to approve one action from a CLI command,
 * even when a model runs it in a non-interactive shell: a terminal prompt when
 * there is a terminal, otherwise a native dialog. There is deliberately no
 * environment or flag to answer it, because whoever runs the command controls
 * both.
 */

import { spawnSync } from 'node:child_process';
import { confirm, isCancel } from '@clack/prompts';

/** true approved, false declined, null when nobody can be asked. */
export type Approver = (message: string) => Promise<boolean | null>;

const TIMEOUT_SECONDS = 300;

/** The dialog program and arguments per platform; the message is always an argument or env value. */
export function dialogCommands(
  message: string,
  platform = process.platform,
  env = process.env
): {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  allowed: (out: string) => boolean;
}[] {
  if (platform === 'darwin')
    return [
      {
        command: 'osascript',
        args: [
          '-e',
          'on run argv',
          '-e',
          `display dialog (item 1 of argv) with title "Hopsql" buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution giving up after ${TIMEOUT_SECONDS}`,
          '-e',
          'end run',
          message,
        ],
        allowed: (out) => out.includes('button returned:Allow') && !out.includes('gave up:true'),
      },
    ];
  if (platform === 'win32')
    return [
      {
        command: 'powershell',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:HOPSQL_APPROVAL_TEXT, "Hopsql", "YesNo", "Warning", "Button2")',
        ],
        env: { ...env, HOPSQL_APPROVAL_TEXT: message },
        allowed: (out) => out.trim() === 'Yes',
      },
    ];
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return [];
  return [
    {
      command: 'zenity',
      args: [
        '--question',
        '--no-markup',
        '--title=Hopsql',
        `--text=${message}`,
        '--ok-label=Allow',
        '--cancel-label=Deny',
        '--default-cancel',
        `--timeout=${TIMEOUT_SECONDS}`,
      ],
      allowed: () => true,
    },
    {
      command: 'kdialog',
      args: [
        '--title',
        'Hopsql',
        '--warningyesno',
        message,
        '--yes-label',
        'Allow',
        '--no-label',
        'Deny',
      ],
      allowed: () => true,
    },
  ];
}

export const askUser: Approver = async (message) => {
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const answer = await confirm({ message, initialValue: false });
    return !isCancel(answer) && answer === true;
  }
  for (const dialog of dialogCommands(message)) {
    const result = spawnSync(dialog.command, dialog.args, {
      encoding: 'utf8',
      env: dialog.env ?? process.env,
      timeout: (TIMEOUT_SECONDS + 10) * 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Not installed: try the next dialog program.
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
    return result.status === 0 && dialog.allowed(result.stdout ?? '');
  }
  return null;
};
