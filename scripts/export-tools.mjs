import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const directory = mkdtempSync(join(tmpdir(), 'hopsql-tools-'));
const client = new Client({ name: 'hopsql-docs', version: '1' });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/index.js')],
      stderr: 'pipe',
      env: {
        ...process.env,
        HOPSQL_WORKSPACE: directory,
        HOPSQL_CONFIG_FILE: '',
        HOPSQL_POLICY_FILE: '',
        HOPSQL_READ_ONLY: 'false',
        HOPSQL_DISABLED_TOOLS: '',
        HOPSQL_ALLOWED_CONNECTIONS: '',
        HOPSQL_UPDATE_NOTIFIER: 'false',
      },
    })
  );
  const tools = (await client.listTools()).tools;
  writeFileSync('docs/tools.json', JSON.stringify(tools, null, 2) + '\n');
  console.error(`Exported ${tools.length} tool schemas`);
} finally {
  await client.close();
  rmSync(directory, { recursive: true, force: true });
}
