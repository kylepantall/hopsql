import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Each seeded fixture starts the production server with an isolated access scope. */
export async function startFixture(environment) {
  const client = new Client({ name: 'hopsql-fixture', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/index.js')],
      stderr: 'pipe',
      env: {
        ...process.env,
        HOPSQL_READ_ONLY: 'false',
        HOPSQL_POLICY_FILE: '',
        HOPSQL_DISABLED_TOOLS: '',
        HOPSQL_UPDATE_NOTIFIER: 'false',
        HOPSQL_DEBUG: 'false',
        ...environment,
      },
    })
  );
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert(!response.isError, JSON.stringify(response.content));
    return JSON.parse(response.content[0].text);
  };
  return { client, call };
}
